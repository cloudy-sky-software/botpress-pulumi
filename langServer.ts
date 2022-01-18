import * as pulumi from "@pulumi/pulumi";
import * as kx from "@pulumi/kubernetesx";
import * as k8s from "@pulumi/kubernetes";

import { AppService, AppServiceArgs } from "./appService";

export interface LangServerArgs extends AppServiceArgs {}

/**
 * The `LangServer` is an app service that represents the Botpress language server
 * used by the main Botpress server.
 * See https://botpress.io/docs/advanced/hosting#running-multiple-containers.
 */
export class LangServer extends AppService {
    public static readonly SERVER_PORT = 3100;

    private langServerArgs: LangServerArgs;

    constructor(args: LangServerArgs, opts: pulumi.ComponentResourceOptions) {
        super("lang-server", args, opts);
        this.langServerArgs = args;

        this.createDeployment();
        this.createService();

        this.registerOutputs({});
    }

    private createDeployment() {
        if (!this.pvc) {
            throw new Error(
                "PersistentVolumeClaim is not initialized. Cannot create a deployment without it."
            );
        }

        const podName = "botpress-lang-server";
        const bpLangServerPodBuilder = new kx.PodBuilder({
            containers: [
                {
                    name: podName,
                    image: `botpress/server:${this.botpressServerVersion}`,
                    ports: {
                        http: LangServer.SERVER_PORT,
                    },
                    command: ["/bin/bash"],
                    args: [
                        "-c",
                        "./bp lang --langDir /botpress/data/embeddings",
                    ],
                    volumeMounts: [this.pvc.mount("/botpress/data")],
                },
            ],
        });
        this.appDeployment = new kx.Deployment(
            "botpress-lang-server",
            {
                spec: bpLangServerPodBuilder.asDeploymentSpec({
                    replicas: this.langServerArgs.numReplicas,
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
            "botpress-lang-server-service",
            {
                metadata: this.getBaseMetadata(),
                spec: {
                    selector: {
                        app: this.appDeployment.metadata.name,
                    },
                    ports: [
                        {
                            name: "http",
                            port: LangServer.SERVER_PORT,
                            targetPort: LangServer.SERVER_PORT,
                        },
                    ],
                },
            },
            { parent: this }
        );
    }

    public getServiceEndpoint(): pulumi.Output<string> {
        if (!this.service) {
            throw new Error("Service is not yet initialized.");
        }

        return pulumi.interpolate`http://${this.service.metadata.name}.${this.langServerArgs.namespace}:${LangServer.SERVER_PORT}`;
    }
}
