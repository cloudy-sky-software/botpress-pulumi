import * as pulumi from "@pulumi/pulumi";
import * as kx from "@pulumi/kubernetesx";
import * as k8s from "@pulumi/kubernetes";

export interface AppServiceArgs {
    clusterId: pulumi.Output<string>;
    namespace: pulumi.Output<string>;
    numReplicas: number;
    storageSize: "25Gi" | "1Gi";
}

/**
 * AppService represents a `Deployment` resource which is exposed as a
 * `Service`. It also creates a PersistentVolumeClaim for use by the
 * service.
 *
 * Since services typically need an ingress controller to accept traffic
 * from the outside (internet), an nginx-based ingress controller is
 * deployed using Helm v2. Underneath, the nginx-ingress controller
 * creates the relevant `Service` of type `LoadBalancer`.
 *
 * By deploying an ingress controller, it also allows each app service
 * to configure it with `Ingress` resources.
 */
export class AppService extends pulumi.ComponentResource {
    private name: string;
    private appServiceArgs: AppServiceArgs;

    private static ingressControllerChart: k8s.helm.v2.Chart | undefined;
    private static appSvcsNamespace: k8s.core.v1.Namespace | undefined;

    protected botpressServerVersion: string;
    protected pvc: kx.PersistentVolumeClaim | undefined;
    protected appDeployment: kx.Deployment | undefined;
    protected service: k8s.core.v1.Service | undefined;

    constructor(name: string, args: AppServiceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("app-service", name, undefined, opts);
        const config = new pulumi.Config();
        this.botpressServerVersion = config.require("botpressServerVersion");
        this.name = name;
        this.appServiceArgs = args;

        this.createStorage();

        if (!AppService.ingressControllerChart) {
            this.createIngressController();
        }
    }

    getDeployment(): kx.Deployment {
        if (!this.appDeployment) {
            throw new Error("Deployment is not yet initialized.");
        }
        return this.appDeployment;
    }

    getService(): k8s.core.v1.Service {
        if (!this.service) {
            throw new Error("Service is not yet initialized.");
        }
        return this.service;
    }

    public static getIngressControllerIp(): pulumi.Output<string> {
        if (!AppService.ingressControllerChart) {
            throw new Error("Ingress controller is not yet initialized.");
        }

        const lbIp = AppService.ingressControllerChart
            .getResource("v1/Service", "app-svcs/nginx-nginx-ingress-controller")
            .apply(v => v.status.loadBalancer.ingress[0].ip);
        return lbIp;
    }

    protected getBaseMetadata(): pulumi.Input<k8s.types.input.meta.v1.ObjectMeta> {
        return {
            namespace: this.appServiceArgs.namespace,
        };
    }

    private createStorage() {
        this.pvc = new kx.PersistentVolumeClaim(`${this.name}-pvc-rw`, {
            metadata: this.getBaseMetadata(),
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage: this.appServiceArgs.storageSize } }
            }
        }, { parent: this });
    }

    /**
     * Deploy the NGINX ingress controller using the Helm chart.
     */
    private createIngressController() {
        AppService.appSvcsNamespace = new k8s.core.v1.Namespace("app-svcs", {
            metadata: {
                name: "app-svcs",
            },
        }, { parent: this });
        AppService.ingressControllerChart = new k8s.helm.v2.Chart("nginx", {
            namespace: AppService.appSvcsNamespace.metadata.name,
            chart: "nginx-ingress",
            version: "1.26.2",
            fetchOpts: {
                repo: "https://kubernetes-charts.storage.googleapis.com/"
            },
            values: {
                controller: {
                    publishService: { enabled: true },
                    config: {
                        "proxy-body-size": "10M",
                        "access-log-path": "logs/access.log",
                        "error-log-path": "logs/error.log",
                        "http-snippet": `
                            # Prevent displaying Botpress in an iframe (clickjacking protection)
                            add_header X-Frame-Options SAMEORIGIN;
                        
                            # Prevent browsers from detecting the mimetype if not sent by the server.
                            add_header X-Content-Type-Options nosniff;
                        
                            # Force enable the XSS filter for the website, in case it was disabled manually
                            add_header X-XSS-Protection "1; mode=block";

                            # Configure the cache for static assets
                            proxy_cache_path /tmp/nginx_cache levels=1:2 keys_zone=my_cache:10m max_size=10g inactive=60m use_temp_path=off;
                        `
                    }
                }
            },
            transformations: [
                (obj: any) => {
                    // Do transformations on the YAML to set the namespace
                    if (obj.metadata) {
                        obj.metadata.namespace = AppService.appSvcsNamespace!.metadata.name.apply(n => n);
                    }
                }
            ],
        }, { parent: this });
    }
}
