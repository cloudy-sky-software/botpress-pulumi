import * as pulumi from "@pulumi/pulumi";
import * as digitalocean from "@pulumi/digitalocean";

import * as uuidv4 from "uuid/v4";
import { createApiClient } from "dots-wrapper";

export interface IncomingResourceArgsInputs {
    k8sClusterId: pulumi.Input<string>;
    dbClusterId: pulumi.Input<string>;
}

interface IncomingResourceArgs {
    k8sClusterId: string;
    dbClusterId: string;
}

class IncomingResourceProvider implements pulumi.dynamic.ResourceProvider {
    check?: (olds: any, news: any) => Promise<pulumi.dynamic.CheckResult>;
    diff?: (id: string, olds: any, news: any) => Promise<pulumi.dynamic.DiffResult>;

    async create (inputs: IncomingResourceArgs): Promise<pulumi.dynamic.CreateResult> {
        const id = uuidv4();
        const client = createApiClient({ endpoint: digitalocean.config.apiEndpoint, token: digitalocean.config.token! });
        const result = await client.database.updateDatabaseClusterFirewallRules({
            database_cluster_id: inputs.dbClusterId,
            rules: [
                {
                    type: "k8s",
                    value: inputs.k8sClusterId,
                    uuid: id,
                    cluster_uuid: inputs.dbClusterId,
                }
            ]
        });

        return {
            id,
            outs: result.data,
        };
    }

    read?: (id: string, props?: any) => Promise<pulumi.dynamic.ReadResult>;
    update?: (id: string, olds: any, news: any) => Promise<pulumi.dynamic.UpdateResult>;
    delete?: (id: string, props: any) => Promise<void>;
}

export class IncomingResource extends pulumi.dynamic.Resource {
    constructor(name: string, inputs: IncomingResourceArgsInputs, opts?: pulumi.CustomResourceOptions) {
        super(new IncomingResourceProvider(), name, {}, opts);
    }
}
