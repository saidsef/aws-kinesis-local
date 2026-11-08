# Testing

The CI workflow runs the suites below on each pull request that changes a file under `src/`, `test/`, `scripts/`, `model/` or `deployment/`, or one of `Dockerfile`, `.dockerignore`, `docker-entrypoint.sh`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json` and `.github/workflows/ci.yml`. The Charts workflow runs the Helm chart suite on each pull request that changes a file under `charts/`. The release workflow runs the unit, integration and Kinesis Client Library suites again before it publishes a version. Each client suite creates streams with unique names, so the suites can share one server.

| Suite | Location | Target | What it covers |
| --- | --- | --- | --- |
| Unit | `test/unit/` | Source modules | Sequence numbers, shard iterators, CBOR against the `cbor2` package, event stream messages against the AWS SDK codec, validation messages, flags and the generated certificate |
| Integration | `test/integration/` | A server in the test process | All 45 operations through the AWS SDK for JavaScript v3 over HTTP/2 and HTTP/1.1, CBOR requests in the style of the AWS SDK for Java, `SubscribeToShard` in JSON and CBOR, TLS, the request size limit, restarts and pending transitions |
| npm package | CI workflow | The packed package | Installs the tarball that `npm pack` builds, runs `aws-kinesis-local --help`, and answers a request through `start()` |
| SDK against the image | `test/integration/sdk.test.ts` | The image | The integration tests for every operation, through `KINESIS_ENDPOINT` |
| AWS CLI | `test/clients/aws-cli.sh` | The image | Streams, records, ARNs, tags, consumers, resharding, waiters and limits through the AWS CLI |
| boto3 | `test/clients/test_boto3.py` | The image | Records, paginators, errors, resharding, `subscribe_to_shard` over HTTP/1.1 and account operations |
| Kinesis Client Library | `test/kcl/` | The image, with DynamoDB local | A KCL 3 consumer in polling mode and in enhanced fan-out mode that must process every record exactly once. It runs in the release workflow only. |
| Vulnerability scan | CI workflow | The image | Trivy fails the workflow on any vulnerability or secret of high or critical severity |
| Kustomize manifests | CI workflow | The image in a kind cluster | Deploys `deployment/` with the image tag that the run pushed, and fails when the StatefulSet does not become ready |
| Helm chart | CI and Charts workflows | The image in a kind cluster | Installs the chart, waits for the StatefulSet to become ready and runs `helm test`, which lists streams through the Service with the AWS CLI. The CI workflow deploys the image tag that the run pushed, and the Charts workflow deploys the release that `appVersion` names. |

The KCL suite sets `shardSyncIntervalMillis` to one second. With the default, KCL pauses for 60 seconds after the first worker creates its leases, which pushes a run close to its deadline. Each mode still spends 40 to 70 seconds in KCL start-up, most of it in fixed waits for instance metadata, the lease table and lease assignment.
