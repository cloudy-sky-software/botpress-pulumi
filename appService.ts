import * as pulumi from "@pulumi/pulumi";
import * as kx from "@pulumi/kubernetesx";
import * as k8s from "@pulumi/kubernetes";

export interface AppServiceArgs {
    clusterId: pulumi.Output<string>;
    namespace: pulumi.Output<string>;
    numReplicas: number;
    /**
     * The storage size of the PVC.
     * See limitations:
     * https://www.digitalocean.com/docs/kubernetes/resources/volume-features/
     */
    storageSize: string;
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
    // The NGINX ingress controller version.
    private ingressControllerVersion: string;

    private static ingressControllerChart: k8s.helm.v3.Chart | undefined;
    public static appSvcsNamespace: k8s.core.v1.Namespace | undefined;
    public static defaultIngressClass:
        | k8s.networking.v1.IngressClass
        | undefined;

    protected botpressServerVersion: string;
    protected pvc: kx.PersistentVolumeClaim | undefined;
    protected appDeployment: kx.Deployment | undefined;
    protected service: k8s.core.v1.Service | undefined;

    constructor(
        name: string,
        args: AppServiceArgs,
        opts?: pulumi.ComponentResourceOptions
    ) {
        super("app-service", name, undefined, opts);
        const config = new pulumi.Config();
        this.ingressControllerVersion = config.require(
            "ingressControllerVersion"
        );
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
            .getResource(
                "v1/Service",
                "app-svcs/nginx-nginx-ingress-controller"
            )
            .apply((v) =>
                v
                    ? v.status.loadBalancer.ingress[0].ip
                    : pulumi.output("unknown-ip")
            );
        return lbIp;
    }

    protected getBaseMetadata(): pulumi.Input<k8s.types.input.meta.v1.ObjectMeta> {
        return {
            namespace: this.appServiceArgs.namespace,
        };
    }

    private createStorage() {
        this.pvc = new kx.PersistentVolumeClaim(
            `${this.name}-pvc-rw`,
            {
                metadata: this.getBaseMetadata(),
                spec: {
                    accessModes: ["ReadWriteOnce"],
                    resources: {
                        requests: { storage: this.appServiceArgs.storageSize },
                    },
                },
            },
            { parent: this }
        );
    }

    /**
     * Deploy the NGINX ingress controller using the Helm chart.
     */
    private createIngressController() {
        AppService.appSvcsNamespace = new k8s.core.v1.Namespace(
            "app-svcs",
            {
                metadata: {
                    name: "app-svcs",
                },
            },
            { parent: this }
        );

        // The ingress class links all ingress objects to a particular ingress controller.
        // It also serves as a way to set default parmaters on ingress objects.
        // However, the nginx ingress controller does not support any parameters at this time.
        AppService.defaultIngressClass = new k8s.networking.v1.IngressClass(
            "defaultIngressClass",
            {
                metadata: {
                    name: "defaultNginxIngressClass",
                    namespace: AppService.appSvcsNamespace?.metadata.name,
                    annotations: {
                        // We'll only have a single nginx controller so we'll mark
                        // this as the default ingress class for all ingress objects.
                        "ingressclass.kubernetes.io/is-default-class": "true",
                    },
                },
                spec: {
                    controller: "k8s.io/nginx-ingress",
                    // nginx-ingress does not support any parameters right now.
                    // https://github.com/kubernetes/ingress-nginx/issues/5593#issuecomment-721479598
                    // As an example of what `parameters` is see the AWS ELB doc.
                    // https://kubernetes-sigs.github.io/aws-load-balancer-controller/v2.3/guide/ingress/ingress_class/#ingressclassparams
                },
            }
        );

        AppService.ingressControllerChart = new k8s.helm.v3.Chart(
            "nginx",
            {
                namespace: AppService.appSvcsNamespace.metadata.name,
                // https://artifacthub.io/packages/helm/ingress-nginx/ingress-nginx
                chart: "ingress-nginx",
                version: this.ingressControllerVersion,
                fetchOpts: {
                    repo: "https://kubernetes.github.io/ingress-nginx",
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
                        `,
                        },
                    },
                },
                transformations: [
                    (obj: any) => {
                        // Do transformations on the YAML to set the namespace
                        if (obj.metadata) {
                            obj.metadata.namespace =
                                AppService.appSvcsNamespace!.metadata.name.apply(
                                    (n) => n
                                );
                        }
                    },
                ],
            },
            { parent: this }
        );
    }
}
