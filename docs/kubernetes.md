# Kubernetes

The Helm chart and the Kustomize manifests each deploy aws-kinesis-local as a single StatefulSet behind a Service. The chart exposes every setting as a value. The Kustomize manifests fix their settings and suit a pinned deployment.

Both deploy one replica by default. Replicas do not share streams, because each replica keeps its own database. A client can reach any replica through the Service, so with more than one replica it can miss a stream that it created over another connection. Both probe the endpoints that [Health check](configuration.md#health-check) describes.

## Helm

```shell
helm repo add kinesis https://saidsef.github.io/aws-kinesis-local/
helm repo update
helm upgrade --install kinesis kinesis/kinesis --namespace kinesis --create-namespace
```

In `kinesis/kinesis`, the first `kinesis` is the repository added above and the second is the chart. The [chart README](https://github.com/saidsef/aws-kinesis-local/blob/main/charts/kinesis/README.md) lists every value and the Kubernetes versions that the chart supports. The chart deploys the release that its `appVersion` names, and `--set image.tag=<version>` deploys another one.

Without persistence, the chart mounts an `emptyDir` at `/data`, so streams last only as long as the pod. With persistence, aws-kinesis-local keeps its SQLite database on the PersistentVolumeClaim. The default `podSecurityContext` sets `fsGroup` to the group that the container runs as, so aws-kinesis-local can write to a volume whose top directory belongs to root. Common overrides:

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

The manifests do not set a namespace, so add `--namespace` to choose one. The Kustomize Service is headless. The `images` entry in `deployment/base/kustomization.yml` sets the image tag, so change `newTag` there to deploy another version.

## Argo CD

`argocd/application.yml` defines an Argo CD Application that syncs `deployment/` from this repository into the `data` namespace, with automated sync, pruning and self-healing. Its annotations ask Argo CD Image Updater to deploy the highest release version on Docker Hub. The `allow-tags` pattern accepts only `X.Y.Z` tags, so Image Updater ignores branch tags, month tags and the `latest`, minor and major tags. Image Updater 1.x reads these annotations when an `ImageUpdater` resource selects the Application and sets `useAnnotations: true`.

```bash
kubectl apply -f argocd/application.yml
```

## Endpoints

[Clients](clients.md#endpoints) lists the in-cluster endpoint for each install path.
