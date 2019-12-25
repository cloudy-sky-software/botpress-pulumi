# Botpress on DigitalOcean

Deploy a Botpress server using DigitalOcean's Kubernetes service.

## What is Botpress?

[Botpress](https://botpress.io/) is an on-prem, open-source chatbot building platform for businesses.

![Botpress](https://assets-global.website-files.com/5cfef8cbe4d7e2bece0c9671/5db8e4b16f2f7675bf63a883_Screen%20Shot%202019-10-29%20at%209.17.05%20PM.png)

## Pulumi

Pulumi makes deploying cloud services easy by allowing you to use a programming language. This lets you create repeatable, and predictable infrastructure.

### Prerequisites

1. Clone this repository to your local machine, and optionally push it up to your own version-control system.
1. [Install Pulumi](https://www.pulumi.com/docs/get-started/install/)
1. [Signup for a free account on Pulumi](https://app.pulumi.com/signup?utm_source=github&utm_medium=social&utm_campaign=botpress-on-digitalocean)
1. [Configure Pulumi for DigitalOcean](https://www.pulumi.com/docs/intro/cloud-providers/digitalocean/setup/)

### Pulumi Stack

Pulumi can store the state of your cluster, which then allows you to track changes as you modify your cluster. In order to store the state on Pulumi, you will need to create a [stack](https://www.pulumi.com/docs/intro/concepts/stack/).

You can also create a stack by running the [`pulumi stack init <stack name>`](https://www.pulumi.com/docs/reference/cli/pulumi_stack_init/) command.

You are now ready to deploy the cluster by simply running `pulumi up`.
