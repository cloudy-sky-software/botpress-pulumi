/**
 * Deploy the Botpress services onto a K8S cluster.
 * This app uses Pulumi's KubernetesX package.
 * 
 * https://botpress.io/docs/advanced/hosting#running-multiple-containers
 * https://github.com/pulumi/pulumi-kubernetesx
 */

import * as pulumi from "@pulumi/pulumi";
import * as digitalocean from "@pulumi/digitalocean";
import * as k8s from "@pulumi/kubernetes";

import { LangServer } from "./langServer";
import { MainServer } from "./mainServer";
import { AppService } from "./appService";

const config = new pulumi.Config();
const domainName = config.get("customDomain");

const nodePoolTag = "botpress";

/**
 * Digital Ocean has some limitations for their Managed Kubernetes offering.
 * Specifically, there are some limitations on the DO block storage volumes created
 * via `PersistentVolumeClaim`s.
 *
 * For example, at the time of this writing, the following limitations apply:
 *
 * Permissions: The other parameters, ReadOnlyMany and ReadWriteMany, are not 
 * supported by DigitalOcean volumes.
 *
 * Resizing block storage volumes has not yet been implemented, and changing 
 * the storage value in the resource definition after the volume has been
 * created will have no effect.
 * 
 * Read more here: https://www.digitalocean.com/docs/kubernetes/.
 */
const cluster = new digitalocean.KubernetesCluster("botpressCluster", {
    name: "botpress-cluster",
    region: digitalocean.Regions.SFO2,
    version: "1.16.2-do.1",
    nodePool: {
        name: "default-pool",
        size: digitalocean.DropletSlugs.DropletS1VCPU2GB,
        nodeCount: 2,
        tags: [ nodePoolTag ]
    }
}, { customTimeouts: { create: "1h" }});

const provider = new k8s.Provider("doK8s", {
    kubeconfig: cluster.kubeConfigs[0].rawConfig,
}, { dependsOn: cluster });

// Create the Namespaces.
const appsNamespace = new k8s.core.v1.Namespace("apps", {
    metadata: {
        name: "apps",
    },
}, { provider });

const langServer = new LangServer({
    namespace: appsNamespace.metadata.name,
    numReplicas: 1,
    storageSize: "25Gi",
}, { provider, parent: cluster});

const mainServer = new MainServer({
    namespace: appsNamespace.metadata.name,
    numReplicas: 1,
    storageSize: "1Gi",
    langServerServiceEndpoint: langServer.getServiceEndpoint(),
}, { provider, parent: cluster, dependsOn: langServer });

export const ingressIp = AppService.getIngressControllerIp();

if (domainName) {
    const domain = new digitalocean.Domain("botpress-domain", {
        /**
         * Ensure that you have registered and own the domain before adding it to DO.
         * DO doesn't support domain registrar services.
         * https://www.digitalocean.com/community/tutorials/how-to-point-to-digitalocean-nameservers-from-common-domain-registrars 
         */
        name: domainName,
        ipAddress: ingressIp,
    });
}
