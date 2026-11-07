# Configuration

The image runs kinesalite on the Node.js Alpine image as the `nobody` user. Its entrypoint, `docker-entrypoint.sh`, turns the environment variables below into kinesalite flags.

## Environment variables

| Variable | kinesalite flag | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | `--port` | `4567` | Port that kinesalite listens on. |
| `KPATH` | `--path` | `/data` | LevelDB directory that holds streams and records. |
| `SHARDLIMIT` | `--shardLimit` | `50` | Maximum number of shards across all streams. |
| `CREATESTREAMMS` | `--createStreamMs` | `50` | Milliseconds that a new stream stays in `CREATING`. |
| `DELETESTREAMMS` | `--deleteStreamMs` | `50` | Milliseconds that a deleted stream stays in `DELETING`. |
| `UPDATESTREAMMS` | `--updateStreamMs` | `50` | Milliseconds that a stream stays in `UPDATING`. |
| `AWS_DEFAULT_REGION` | None | `eu-west-1` | Region in the stream ARNs that kinesalite returns. `AWS_REGION` overrides it. |
| `AWS_ACCOUNT_ID` | None | `000000000000` | Account ID in the stream ARNs that kinesalite returns. |

## kinesalite flags

The entrypoint passes any arguments after the image name to kinesalite. For example, `--ssl` serves HTTPS with the self-signed certificate that kinesalite ships:

```bash
docker run -d -p 4567:4567 docker.io/saidsef/aws-kinesis-local:latest --ssl
aws --endpoint-url https://localhost:4567 --no-verify-ssl kinesis list-streams
```

To list every flag, run:

```bash
docker run --rm docker.io/saidsef/aws-kinesis-local:latest --help
```

## Data storage

kinesalite keeps streams and records under `KPATH`, which the image declares as a volume. Mount a named volume there to keep streams across container restarts:

```bash
docker run -d -p 4567:4567 -v kinesis-data:/data docker.io/saidsef/aws-kinesis-local:latest
```

## Health check

The image health check opens a TCP connection to `PORT` every 60 seconds.
