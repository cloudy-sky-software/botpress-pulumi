import * as pulumi from "@pulumi/pulumi";
import * as digitalocean from "@pulumi/digitalocean";
import * as kx from "@pulumi/kubernetesx";
import * as k8s from "@pulumi/kubernetes";
import * as fs from "fs";

import { AppService, AppServiceArgs } from "./appService";

export interface MainServerArgs extends AppServiceArgs {
    langServerServiceEndpoint: pulumi.Output<string>;
    domainName?: string;
    bpfsStorage: "disk" | "database";
    /**
     * The size of the nodes in the database cluster.
     * Required only if `bpfsStorage` is set to `database`.
     */
    dbSize?: digitalocean.DatabaseSlug;
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
        this.dbCluster = new digitalocean.DatabaseCluster(
            "dbCluster",
            {
                name: "bp-db-cluster",
                version: "12",
                tags: ["botpress"],
                engine: "pg",
                nodeCount: 2,
                region: digitalocean.Region.SFO2,
                size:
                    this.serverArgs.dbSize ||
                    digitalocean.DatabaseSlug.DB_1VPCU1GB,
            },
            { parent: this }
        );

        const db = new digitalocean.DatabaseDb(
            "bpDb",
            {
                name: "botpress",
                clusterId: this.dbCluster.id,
            },
            { parent: this.dbCluster }
        );

        this.dbConnectionPool = new digitalocean.DatabaseConnectionPool(
            "bpConnectionPool",
            {
                clusterId: this.dbCluster.id,
                mode: "transaction",
                size: 10,
                name: "bpConnectionPool",
                dbName: db.name,
                user: this.dbCluster.user,
            },
            { parent: this.dbConnectionPool }
        );

        // Add the DOKS as a trusted resource to the DB cluster.
        const trustedResource = new digitalocean.DatabaseFirewall(
            "dbTrustedResource",
            {
                clusterId: this.dbCluster.id,
                rules: [
                    {
                        type: "k8s",
                        value: this.serverArgs.clusterId,
                    },
                ],
            },
            { parent: this.dbCluster }
        );
    }

    private createDeployment() {
        if (!this.pvc) {
            throw new Error(
                "PersistentVolumeClaim is not initialized. Cannot create a deployment without it."
            );
        }

        const volumeMounts = [this.pvc.mount("/botpress/data")];
        if (this.serverArgs.bpfsStorage === "database") {
            if (!this.dbCluster) {
                throw new Error(
                    "Botpress storage type database requires a database cluster to be created but it doesn't seem to have been created!"
                );
            }

            const configMap = new kx.ConfigMap(
                "bp-server-config-map",
                {
                    metadata: this.getBaseMetadata(),
                    data: {
                        "db-cluster-ca-cert": this.dbCluster.id.apply((id) =>
                            pulumi
                                .output(
                                    digitalocean.getDatabaseCa({
                                        clusterId: id,
                                    })
                                )
                                .apply((r) => r.certificate)
                        ),
                    },
                },
                { parent: this }
            );
            volumeMounts.push(
                // Add the CA cert config map as a volume mount for the Main Server's deployment.
                configMap.mount(
                    "/usr/local/share/ca-certificates/db-cluster-ca-cert.crt"
                )
            );
        }

        const podName = "botpress-server";
        const botpressServerPodBuilder = new kx.PodBuilder({
            containers: [
                {
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
                            value: this.serverArgs.domainName
                                ? this.serverArgs.domainName
                                : pulumi.interpolate`http://${AppService.getIngressControllerIp()}`,
                        },
                        {
                            name: "BPFS_STORAGE",
                            value: this.serverArgs.bpfsStorage,
                        },
                        {
                            name: "DATABASE_URL",
                            /**
                             * Append `&ssl=1` to the connection string. The driver used by Botpress uses
                             * `pg-connection-string` npm package to parse the connection string.
                             * It detects the presence of an `ssl` query-param in order to set
                             * SSL mode to true.
                             */
                            value: this.dbConnectionPool
                                ? pulumi.interpolate`${this.dbConnectionPool.privateUri}&ssl=1`
                                : "",
                        },
                        {
                            name: "DATABASE_POOL",
                            value: `{"min":3,"max":10}`,
                        },
                        {
                            /**
                             * The db driver used by Botpress looks for this env var
                             * to use the right SSL mode.
                             * https://github.com/brianc/node-postgres/blob/master/packages/pg/lib/connection-parameters.js#L31
                             */
                            name: "PGSSLMODE",
                            value: "require",
                        },
                    ],
                    volumeMounts,
                },
            ],
        });
        this.appDeployment = new kx.Deployment(
            podName,
            {
                spec: botpressServerPodBuilder.asDeploymentSpec({
                    replicas: this.serverArgs.numReplicas,
                }),
                metadata: {
                    ...this.getBaseMetadata(),
                    // Without the `name`, the service fails to find the pod to direct traffic to.
                    name: podName,
                    labels: {
                        app: podName,
                    },
                },
            },
            { parent: this }
        );
    }

    private createService() {
        if (!this.appDeployment) {
            throw new Error("Cannot create a service without a deployment.");
        }

        this.service = new k8s.core.v1.Service(
            "botpress-server-service",
            {
                metadata: this.getBaseMetadata(),
                spec: {
                    selector: {
                        app: this.appDeployment.metadata.name,
                    },
                    ports: [
                        {
                            name: "http",
                            port: MainServer.SERVER_PORT,
                            targetPort: MainServer.SERVER_PORT,
                        },
                    ],
                },
            },
            { parent: this }
        );
    }

    /**
     * Create an Ingress resource pointing to the botpress server service.
     */
    private createIngressResources() {
        try {
            this.getDeployment();
            this.getService();
        } catch (err) {
            pulumi.log.info(
                "Some resources are not yet ready.",
                this,
                undefined,
                true
            );
            return;
        }

        const ingressServiceBackend: k8s.types.input.networking.v1.IngressServiceBackend =
            {
                name: this.getService().metadata.name,
                port: {
                    number: MainServer.SERVER_PORT,
                },
            };
        // Create an Ingress resource pointing to the botpress server service.
        const assetsIngress = new k8s.networking.v1.Ingress(
            "assets-ingress",
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
                        `,
                    },
                },
                spec: {
                    rules: [
                        {
                            http: {
                                paths: [
                                    {
                                        path: "/.+/assets/.*",
                                        pathType: "Prefix",
                                        backend: {
                                            service: ingressServiceBackend,
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
            { parent: this }
        );
        const socketIoIngress = new k8s.networking.v1.Ingress(
            "socketio-ingress",
            {
                metadata: {
                    labels: this.getDeployment().metadata.labels,
                    namespace: this.serverArgs.namespace,
                    annotations: {
                        "kubernetes.io/ingress.class": "nginx",
                        "nginx.ingress.kubernetes.io/configuration-snippet": `
                            proxy_set_header Upgrade $http_upgrade;
                            proxy_set_header Connection "Upgrade";
                        `,
                    },
                },
                spec: {
                    rules: [
                        {
                            http: {
                                paths: [
                                    {
                                        path: "/socket.io/",
                                        pathType: "Prefix",
                                        backend: {
                                            service: ingressServiceBackend,
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
            { parent: this }
        );
        const defaultIngress = new k8s.networking.v1.Ingress(
            "root-ingress",
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
                                        pathType: "Exact",
                                        backend: {
                                            service: ingressServiceBackend,
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
            { parent: this }
        );
    }
}
