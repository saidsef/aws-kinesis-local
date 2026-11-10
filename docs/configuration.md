# Configuration

The Docker image runs aws-kinesis-local on the Node.js Alpine image as the `nobody` user. Its entrypoint, `docker-entrypoint.sh`, turns the environment variables below into command-line flags.

## Environment variables

| Variable | Flag | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | `--port` | `4567` | Port that aws-kinesis-local listens on, for HTTP/1.1 and HTTP/2. |
| `KPATH` | `--path` | `/data` | Directory that holds the SQLite database of streams and records. |
| `SHARDLIMIT` | `--shardLimit` | `50` | Maximum number of open shards across all provisioned streams. |
| `CREATESTREAMMS` | `--createStreamMs` | `50` | Milliseconds that a new stream, consumer or channel stays in `CREATING`. |
| `DELETESTREAMMS` | `--deleteStreamMs` | `50` | Milliseconds that a deleted stream, consumer or channel stays in `DELETING`. |
| `UPDATESTREAMMS` | `--updateStreamMs` | `50` | Milliseconds that a stream or channel stays in `UPDATING`. |
| `AWS_DEFAULT_REGION` | None | `eu-west-1` | Region in the ARNs that aws-kinesis-local returns. `AWS_REGION` overrides it. |
| `AWS_ACCOUNT_ID` | None | `000000000000` | Account ID in the ARNs and error messages that aws-kinesis-local returns. |

## Flags

The entrypoint passes any arguments after the image name to aws-kinesis-local.

| Flag | Purpose |
| --- | --- |
| `--ssl` | Accepts TLS connections only, and closes plain HTTP connections. |
| `--key <file>` | PEM private key for TLS connections, instead of the generated one. |
| `--cert <file>` | PEM certificate for TLS connections, instead of the generated one. |
| `--help` | Prints every flag and its default, then exits. |

The `aws-kinesis-local` command from npm takes the same flags. Without the entrypoint, it uses port 4567, an in-memory store, a shard limit of 10 and 500 milliseconds for each state change.

## TLS

aws-kinesis-local accepts TLS and plain HTTP connections on the same port, and a TLS client negotiates HTTP/2 or HTTP/1.1 through ALPN. The Kinesis Producer Library, which always connects with TLS, can share one server with clients that use plain HTTP:

```bash
docker run -d -p 4567:4567 docker.io/saidsef/aws-kinesis-local:latest
aws --endpoint-url http://localhost:4567 kinesis list-streams
aws --endpoint-url https://localhost:4567 --no-verify-ssl kinesis list-streams
```

aws-kinesis-local generates a self-signed certificate for `localhost`, `127.0.0.1` and `::1` at start-up. `--key` and `--cert` replace it with a key and certificate from PEM files. `--ssl` closes every connection that does not open with a TLS handshake.

## Data storage

aws-kinesis-local keeps streams, records, consumers, channels, policies and account settings in a SQLite database, `aws-kinesis-local.sqlite`, under `KPATH`. The `nobody` user, with user and group ID 65534, needs write access to that directory. Without it, aws-kinesis-local exits at start-up with `Error: unable to open database file`.

The image declares `KPATH` as a volume. Mount a named volume there to keep streams across container restarts:

```bash
docker run -d -p 4567:4567 -v kinesis-data:/data docker.io/saidsef/aws-kinesis-local:latest
```

## Shutdown

aws-kinesis-local stops on `SIGTERM` and `SIGINT`. It reports that it is not ready, stops accepting connections, ends every `SubscribeToShard` response and lets the requests in progress finish. It closes the database last. When requests are still running after the time limit, which the `shutdownMs` option of `start()` sets, it closes their connections. A stream, consumer or channel that is in a transitional state when it stops finishes that change on the next start.

## Health check

aws-kinesis-local answers two health endpoints on `PORT`, and every other `GET` request returns a 403 error.

| Path | 200 | 503 |
| --- | --- | --- |
| `/healthz` | The server can read its database | The server cannot read its database |
| `/readyz` | The server can read its database and is not shutting down | The server cannot read its database, or shutdown has started |

The image health check requests `/healthz` every 60 seconds. It tries HTTP first and then HTTPS, so it also works with `--ssl`. The Helm chart and the Kustomize manifests use `/healthz` for the startup and liveness probes and `/readyz` for the readiness probe.
