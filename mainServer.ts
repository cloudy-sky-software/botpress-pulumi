import * as pulumi from "@pulumi/pulumi";
import * as digitalocean from "@pulumi/digitalocean";
import * as kx from "@pulumi/kubernetesx";
import * as k8s from "@pulumi/kubernetes";

import * as fs from "fs";

import { AppService, AppServiceArgs } from "./appService";
import { IncomingResource } from "./dbClusterIncomingResource";

export interface MainServerArgs extends AppServiceArgs {
    langServerServiceEndpoint: pulumi.Output<string>;
    domainName?: string;
    bpfsStorage: "disk" | "database";
}

/**
 * The `MainServer` is an app service that represents the main
 * Botpress server and the Duckling server running in the same container.
 * See https://botpress.io/docs/advanced/hosting#running-multiple-containers.
 */
export class MainServer extends AppService {
    public static readonly SERVER_PORT = 3000;

    private serverArgs: MainServerArgs;
    private dbCluster: digitalocean.DatabaseCluster | undefined;
    private dbConnectionPool: digitalocean.DatabaseConnectionPool | undefined;

    constructor(args: MainServerArgs, opts: pulumi.ComponentResourceOptions) {
        super("main-server", args, opts);
        this.serverArgs = args;

        if (this.serverArgs.bpfsStorage === "database") {
            this.createDbCluster();
        }
        this.createDeployment();
        this.createService();
        this.createIngressResources();

        this.registerOutputs({});
    }

    private createDbCluster() {
        this.dbCluster = new digitalocean.DatabaseCluster("dbCluster", {
            name: "bp-db-cluster",
            version: "11",
            tags: ["botpress"],
            engine: "pg",
            nodeCount: 2,
            region: digitalocean.Regions.SFO2,
            size: digitalocean.DatabaseSlugs.DB_2VPCU4GB,
        }, { parent: this });


        const db = new digitalocean.DatabaseDb("bpDb", {
            name: "botpress",
            clusterId: this.dbCluster.id,
        }, { parent: this.dbCluster });

        this.dbConnectionPool = new digitalocean.DatabaseConnectionPool("bpConnectionPool", {
            clusterId: this.dbCluster.id,
            mode: "transaction",
            size: 10,
            name: "bpConnectionPool",
            dbName: db.name,
            user: this.dbCluster.user,
        }, { parent: this.dbConnectionPool });

        const dbTrustedResource = new IncomingResource("db-trusted-resource", {
            dbClusterId: this.dbCluster.id,
            k8sClusterId: this.serverArgs.clusterId,
        }, { parent: this, dependsOn: this.dbCluster });
    }

    private createDeployment() {
        if (!this.pvc) {
            throw new Error("PersistentVolumeClaim is not initialized. Cannot create a deployment without it.");
        }

        const configMap = new kx.ConfigMap("bp-server-config-map", {
            metadata: this.getBaseMetadata(),
            data: {
                "db-cluster-ca-cert": fs.readFileSync("digitalocean-db-cluster-ca-certificate.crt").toString("utf8"),
            },
        }, { parent: this });

        const podName = "botpress-server";
        const botpressServerPodBuilder = new kx.PodBuilder({
            containers: [{
                name: podName,
                image: `botpress/server:${this.botpressServerVersion}`,
                ports: {
                    http: MainServer.SERVER_PORT,
                },
                command: ["/bin/bash"],
                args: ["-c", "./duckling & ./bp"],
                env: [
                    {
                        name: "BP_MODULE_NLU_LANGUAGESOURCES",
                        value: pulumi.interpolate`[{ "endpoint": "${this.serverArgs.langServerServiceEndpoint}" }]`,
                    },
                    {
                        name: "EXTERNAL_URL",
                        value: this.serverArgs.domainName ? this.serverArgs.domainName : AppService.getIngressControllerIp(),
                    },
                    {
                        name: "BPFS_STORAGE",
                        value: this.serverArgs.bpfsStorage,
                    },
                    {
                        name: "DATABASE_URL",
                        value: this.dbConnectionPool ? this.dbConnectionPool.privateUri : "",
                    },
                    {
                        name: "DATABASE_POOL",
                        value: `{"min":3,"max":10}`,
                    },
                ],
                volumeMounts: [
                    this.pvc.mount("/botpress/data"),
                    configMap.mount("/etc/ssl/certs/db-cluster-ca-cert.crt"),
                ],
            }],
        });
        this.appDeployment = new kx.Deployment(podName, {
            spec: botpressServerPodBuilder.asDeploymentSpec({ replicas: this.serverArgs.numReplicas }),
            metadata: {
                ...this.getBaseMetadata(),
                // Without the `name`, the service fails to find the pod to direct traffic to.
                name: podName,
                labels: {
                    "app": podName,
                },
            },
        }, { parent: this });
    }

    private createService() {
        if (!this.appDeployment) {
            throw new Error("Cannot create a service without a deployment.");
        }

        this.service = new k8s.core.v1.Service("botpress-server-service", {
            metadata: this.getBaseMetadata(),
            spec: {
                selector: {
                    "app": this.appDeployment.metadata.name,
                },
                ports: [{
                    name: "http",
                    port: MainServer.SERVER_PORT,
                    targetPort: MainServer.SERVER_PORT,
                }],
            }
        }, { parent: this });
    }

    /**
     * Create an Ingress resource pointing to the botpress server service.
     */
    private createIngressResources() {
        try {
            this.getDeployment();
            this.getService();
        } catch (err) {
            pulumi.log.info("Some resources are not yet ready.", this, undefined, true);
            return;
        }

        // Create an Ingress resource pointing to the botpress server service.
        const assetsIngress = new k8s.networking.v1beta1.Ingress("assets-ingress",
            {
                metadata: {
                    labels: this.getDeployment().metadata.labels,
                    namespace: this.serverArgs.namespace,
                    annotations: {
                        "kubernetes.io/ingress.class": "nginx",
                        "nginx.ingress.kubernetes.io/use-regex": "true",
                        "nginx.ingress.kubernetes.io/configuration-snippet": `
                            proxy_cache my_cache;
                            proxy_ignore_headers Cache-Control;
                            proxy_hide_header Cache-Control;
                            proxy_hide_header Pragma;
                            proxy_cache_valid any 30m;
                            proxy_set_header Cache-Control max-age=30;
                            add_header Cache-Control max-age=30;
                        `
                    },
                },
                spec: {
                    rules: [
                        {
                            http: {
                                paths: [
                                    {
                                        path: "/.+/assets/.*",
                                        backend: {
                                            serviceName: this.getService().metadata.name,
                                            servicePort: MainServer.SERVER_PORT,
                                        },
                                    },
                                ],
                            },
                        }
                    ]
                }
            }, { parent: this }
        );
        const socketIoIngress = new k8s.networking.v1beta1.Ingress("socketio-ingress",
            {
                metadata: {
                    labels: this.getDeployment().metadata.labels,
                    namespace: this.serverArgs.namespace,
                    annotations: {
                        "kubernetes.io/ingress.class": "nginx",
                        "nginx.ingress.kubernetes.io/configuration-snippet": `
                            proxy_set_header Upgrade $http_upgrade;
                            proxy_set_header Connection "Upgrade";
                        `
                    },
                },
                spec: {
                    rules: [
                        {
                            http: {
                                paths: [
                                    {
                                        path: "/socket.io/",
                                        backend: {
                                            serviceName: this.getService().metadata.name,
                                            servicePort: MainServer.SERVER_PORT,
                                        },
                                    },
                                ],
                            },
                        }
                    ]
                }
            }, { parent: this }
        );
        const defaultIngress = new k8s.networking.v1beta1.Ingress("root-ingress",
            {
                metadata: {
                    labels: this.getDeployment().metadata.labels,
                    namespace: this.serverArgs.namespace,
                    annotations: {
                        "kubernetes.io/ingress.class": "nginx",
                    },
                },
                spec: {
                    rules: [
                        {
                            http: {
                                paths: [
                                    {
                                        path: "/",
                                        backend: {
                                            serviceName: this.getService().metadata.name,
                                            servicePort: MainServer.SERVER_PORT,
                                        }
                                    },
                                ],
                            },
                        }
                    ]
                }
            }, { parent: this }
        );
    }
}
