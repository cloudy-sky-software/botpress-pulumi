import * as pulumi from "@pulumi/pulumi";
import * as kx from "@pulumi/kubernetesx";
import * as k8s from "@pulumi/kubernetes";

import { AppService, AppServiceArgs } from "./appService";

export interface MainServerArgs extends AppServiceArgs {
    langServerServiceEndpoint: pulumi.Output<string>;
}

/**
 * The `MainServer` is an app service that represents the main
 * Botpress server and the Duckling server running in the same container.
 * See https://botpress.io/docs/advanced/hosting#running-multiple-containers.
 */
export class MainServer extends AppService {
    public static readonly SERVER_PORT = 3000;

    private serverArgs: MainServerArgs;

    constructor(args: MainServerArgs, opts: pulumi.ComponentResourceOptions) {
        super("main-server", args, opts);
        this.serverArgs = args;

        this.createDeployment();
        this.createService();
        this.createIngressResources();

        this.registerOutputs({});
    }

    private createDeployment() {
        if (!this.pvc) {
            throw new Error("PersistentVolumeClaim is not initialized. Cannot create a deployment without it.");
        }

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
                    }
                ],
                volumeMounts: [this.pvc.mount("/botpress/data")],
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
