# Docker Kinesis Local [![CI](https://github.com/saidsef/aws-kinesis-local/actions/workflows/docker.yml/badge.svg)](#howto-and-documentation) [![Tagging](https://github.com/saidsef/aws-kinesis-local/actions/workflows/charts.yml/badge.svg)](#howto-and-documentation)

Built for local AWS Kinesis development and CI: a small container image and Helm/Kustomize manifests that run [`kinesalite`](https://github.com/mhart/kinesalite) on Kubernetes.

## Amazon Kinesis Streams

Amazon Kinesis Streams lets you build your own apps to deal with streaming data, tailored to your specific requirements. It achieves this by:

* **Continuous Data Capture:** reliably storing huge volumes of data (terabytes per hour) from masses of sources. Think website activity, financial trades, social media, system logs, and location tracking.
* **Custom App Development:** using the Amazon Kinesis Client Library (KCL) to build applications that use this stream of data.
* **Real-Time Use Cases:** powering things like live dashboards, automated alerts, dynamic pricing models, and targeted advertising.
* **Integration with AWS:** feeding data from Kinesis Streams into other AWS services, such as Amazon S3, Amazon Redshift, Amazon EMR, and AWS Lambda.

## Components

* Node.js (Alpine base image)
* [kinesalite](https://github.com/mhart/kinesalite) — the in-process Kinesis emulator

## HowTo and Documentation

```bash
docker run --rm docker.io/saidsef/aws-kinesis-local --help
```

`kinesalite` flags exposed via environment variables (defaults shown):

| Env var | kinesalite flag | Default |
| --- | --- | --- |
| `PORT` | `--port` | `4567` |
| `KPATH` | `--path` | `/data` |
| `SHARDLIMIT` | `--shardLimit` | `50` |
| `CREATESTREAMMS` | `--createStreamMs` | `50` |
| `DELETESTREAMMS` | `--deleteStreamMs` | `50` |
| `UPDATESTREAMMS` | `--updateStreamMs` | `50` |

Extra CLI args passed to `docker run ... <args>` are forwarded to `kinesalite`.

## Local Deployment

```bash
docker run -d -p 4567:4567 docker.io/saidsef/aws-kinesis-local:latest
```

```bash
aws --endpoint-url=http://localhost:4567 kinesis list-streams --region eu-west-1

{
    "StreamNames": []
}
```

## Kubernetes Deployment

Both install paths below deploy a single `StatefulSet` plus a `Service`. Pick Helm if you want parameterised installs (persistence, PDB, env tuning); pick Kustomize for a pinned, opinionated deployment.

### Helm

```shell
helm repo add kinesis https://saidsef.github.io/aws-kinesis-local/
helm repo update
helm upgrade --install kinesis kinesis/kinesis --namespace kinesis --create-namespace
```

The second `kinesis` in `kinesis/kinesis` is the chart name within the repo added on the previous line.

### Kubectl (Kustomize)

```bash
kubectl apply -k deployment/
```

### ArgoCD

```bash
kubectl apply -f argocd/application.yml
```

## Configuration

The Helm chart's tunables (image tag, resources, probes, persistence, PDB, helm-test region, etc.) are documented in [`charts/kinesis/values.yaml`](./charts/kinesis/values.yaml) and the rendered [`charts/kinesis/HELM.md`](./charts/kinesis/HELM.md). Common overrides:

```shell
# Enable persistent storage for /data
helm upgrade --install kinesis kinesis/kinesis \
  --set persistence.enabled=true --set persistence.size=2Gi

# Switch the Service to headless (for StatefulSet DNS)
helm upgrade --install kinesis kinesis/kinesis --set service.headless=true

# Override kinesalite env knobs
helm upgrade --install kinesis kinesis/kinesis \
  --set env.SHARDLIMIT=200 --set env.PORT=4567
```

## Testing

### AWS CLI / SDK

```bash
aws --endpoint-url=http://<kinesis-host>:<port> kinesis list-streams --region eu-west-1

{
    "StreamNames": []
}
```

```javascript
// npm install @aws-sdk/client-kinesis
const { KinesisClient, ListStreamsCommand } = require('@aws-sdk/client-kinesis');

const kinesis = new KinesisClient({
  endpoint: 'http://kinesis.<namespace>.svc',
  region: 'eu-west-1',
});
kinesis.send(new ListStreamsCommand({})).then(console.log);
```

> The `endpoint` value depends on your deployment type.

> See the [AWS Kinesis SDK reference](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/kinesis/).

### Helm test

After `helm install`, run:

```bash
helm test kinesis --namespace kinesis
```

This launches an `aws-cli` pod that calls `kinesis list-streams` against the in-cluster service.

## Source

Source lives on [GitHub](https://github.com/saidsef/aws-kinesis-local). Fork us!

## Contributing

We would :heart:  you to contribute by making a [pull request](https://github.com/saidsef/aws-kinesis-local/pulls).

Please read the official [Contribution Guide](./CONTRIBUTING.md) for more information on how you can contribute.
