# Kubernetes

The Helm chart and the Kustomize manifests each deploy aws-kinesis-local as a single StatefulSet behind a Service. The chart exposes every setting as a value. The Kustomize manifests fix their settings and suit a pinned deployment.

## Helm

```shell
helm repo add kinesis https://saidsef.github.io/aws-kinesis-local/
helm repo update
helm upgrade --install kinesis kinesis/kinesis --namespace kinesis --create-namespace
```

In `kinesis/kinesis`, the first `kinesis` is the repository added above and the second is the chart. The [chart README](https://github.com/saidsef/aws-kinesis-local/blob/main/charts/kinesis/README.md) lists every value and the Kubernetes versions that the chart supports.

Without persistence, the chart mounts an `emptyDir` at `/data`, so streams last only as long as the pod. With persistence, aws-kinesis-local keeps its SQLite database on the PersistentVolumeClaim. Common overrides:

```shell
# Keep streams on a PersistentVolumeClaim
helm upgrade --install kinesis kinesis/kinesis \
  --set persistence.enabled=true --set persistence.size=2Gi

# Make the Service headless
helm upgrade --install kinesis kinesis/kinesis --set service.headless=true

# Raise the shard limit
helm upgrade --install kinesis kinesis/kinesis --set env.SHARDLIMIT=200
```

The chart sets each key under `env` as a container environment variable, so `env` accepts any variable from [Configuration](configuration.md#environment-variables).

### Helm test

```bash
helm test kinesis --namespace kinesis
```

The test pod runs `aws kinesis list-streams` against the Service with the AWS CLI image.

## Kustomize

```bash
kubectl apply -k deployment/
```

The manifests do not set a namespace, so add `--namespace` to choose one. The Kustomize Service is headless.

## Argo CD

`argocd/application.yml` defines an Argo CD Application that syncs `deployment/` from this repository into the `data` namespace, with automated sync, pruning and self-healing. Its annotations ask Argo CD Image Updater to follow the most recently built image.

```bash
kubectl apply -f argocd/application.yml
```

## Endpoints

[Clients](clients.md#endpoints) lists the in-cluster endpoint for each install path.
