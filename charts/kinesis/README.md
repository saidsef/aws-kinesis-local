# kinesis

![Version: 0.10.1](https://img.shields.io/badge/Version-0.10.1-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 1.0.2](https://img.shields.io/badge/AppVersion-1.0.2-informational?style=flat-square)

A Kinesis Local Helm chart for Kubernetes

**Homepage:** <https://github.com/saidsef/aws-kinesis-local>

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| Said Sef | <saidsef@gmail.com> | <https://saidsef.co.uk/> |

## Source Code

* <https://github.com/saidsef/aws-kinesis-local.git>

## Requirements

Kubernetes: `>= 1.32.0`

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| affinity | object | `{}` | Pod affinity rules. |
| env.CREATESTREAMMS | string | `"50"` | `--createStreamMs`, how long in milliseconds a new stream, consumer or channel stays in `CREATING`. |
| env.DELETESTREAMMS | string | `"50"` | `--deleteStreamMs`, how long in milliseconds a deleted stream, consumer or channel stays in `DELETING`. |
| env.KPATH | string | `"/data"` | `--path`, the directory that holds the SQLite database. The chart mounts the data volume here. |
| env.PORT | string | `"4567"` | `--port`, the port that aws-kinesis-local listens on for HTTP/1.1 and HTTP/2. Also sets the container port. |
| env.SHARDLIMIT | string | `"50"` | `--shardLimit`, the maximum number of open shards across all provisioned streams. |
| env.UPDATESTREAMMS | string | `"50"` | `--updateStreamMs`, how long in milliseconds a stream or channel stays in `UPDATING`. |
| fullnameOverride | string | `""` | Override the fully qualified app name. |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| image.repository | string | `"docker.io/saidsef/aws-kinesis-local"` | Image repository. |
| image.tag | string | `""` | Image tag. Empty uses the chart `appVersion`, which matches the npm package version. |
| imagePullSecrets | list | `[]` | Pull secrets for private registries. |
| livenessProbe | object | `tcpSocket port=tcp, periodSeconds=10` | Liveness probe spec. |
| nameOverride | string | `""` | Override the chart name. |
| nodeSelector | object | `{}` | Node selector. |
| persistence.accessModes | list | `["ReadWriteOnce"]` | PVC access modes when persistence is enabled. |
| persistence.enabled | bool | `false` | Back `/data` with a `volumeClaimTemplate` instead of `emptyDir`. |
| persistence.size | string | `"1Gi"` | PVC size. |
| persistence.storageClass | string | `""` | StorageClass name. Empty uses the cluster default. |
| podAnnotations | object | `{}` | Pod annotations. |
| podDisruptionBudget.enabled | bool | `false` | Render a `policy/v1 PodDisruptionBudget`. |
| podDisruptionBudget.maxUnavailable | int | `1` | PDB `maxUnavailable`. The default lets a node drain evict the pod when the chart runs one replica. The chart ignores this value when `minAvailable` is set. |
| podDisruptionBudget.minAvailable | int | unset | PDB `minAvailable`. When this value is set, it wins over `maxUnavailable`, and the PDB carries only `minAvailable`. |
| podSecurityContext | object | `{"fsGroup":65534,"fsGroupChangePolicy":"OnRootMismatch"}` | Pod-level securityContext. `fsGroup` makes Kubernetes set the group of the data volume to 65534, the group that the container runs as, and make it writable by that group. aws-kinesis-local can then open its database on a volume that root owns. With `OnRootMismatch`, Kubernetes changes ownership and permissions only when those of the volume root do not already match. |
| readinessProbe | object | `tcpSocket port=tcp, periodSeconds=5` | Readiness probe spec. |
| replicaCount | int | `1` | StatefulSet replica count. Replicas do not share streams. Each replica keeps its own database, and the Service spreads connections across all replicas, so a request can reach a replica that does not hold the stream. |
| resources.limits.cpu | string | `"200m"` | CPU limit. |
| resources.limits.memory | string | `"1Gi"` | Memory limit. |
| resources.requests.cpu | string | `"100m"` | CPU request. |
| resources.requests.memory | string | `"512Mi"` | Memory request. |
| revisionHistoryLimit | int | `5` | StatefulSet `revisionHistoryLimit`. |
| securityContext | object | hardened defaults | Container `securityContext`: non-root, read-only rootfs, all caps dropped, seccomp RuntimeDefault. |
| service.headless | bool | `false` | Set `clusterIP: None` for headless DNS. Clients then reach the pods on the container port, `env.PORT`, and not on `service.port`. |
| service.port | int | `80` | Service port. |
| service.testRegion | string | `"eu-west-1"` | Region passed to the `helm test` aws-cli call. |
| service.type | string | `"ClusterIP"` | Service type. |
| serviceAccount.annotations | object | `{}` | ServiceAccount annotations. |
| serviceAccount.create | bool | `true` | Whether to create a ServiceAccount. |
| serviceAccount.name | string | `""` | If empty, defaults to the fullname. |
| startupProbe | object | `tcpSocket port=tcp, failureThreshold=30` | Startup probe spec. |
| terminationGracePeriodSeconds | int | `60` | Pod terminationGracePeriodSeconds. |
| testImage.pullPolicy | string | `"IfNotPresent"` | Pull policy for the helm-test image. |
| testImage.repository | string | `"amazon/aws-cli"` | helm-test image repo. |
| testImage.tag | string | `"2.17.0"` | helm-test image tag (pinned). |
| tolerations | list | `[]` | Pod tolerations. |
| topologySpreadConstraints | list | `[]` | Pod topology spread constraints. |

----------------------------------------------
Autogenerated from chart metadata using [helm-docs v1.14.2](https://github.com/norwoodj/helm-docs/releases/v1.14.2)
