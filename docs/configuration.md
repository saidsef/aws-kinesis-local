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
| `LOGLEVEL` | `--logLevel` | `warn` | Least severe level that aws-kinesis-local logs, as [Logs](#logs) describes. |
| `S3ENDPOINT` | `--s3Endpoint` | None | S3 endpoint that channels deliver records to, as [Channel delivery](#channel-delivery) describes. Without it, channels do not deliver. |
| `S3REGION` | `--s3Region` | Region in ARNs | Region in the signature of each S3 request. |
| `DELIVERYINTERVALMS` | `--deliveryIntervalMs` | None | Milliseconds that a channel buffers records before it writes an object. Without it, each channel uses its data freshness interval. |
| `S3_ACCESS_KEY_ID` | None | None | Access key ID that signs each S3 request. |
| `S3_SECRET_ACCESS_KEY` | None | None | Secret access key that signs each S3 request. |
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

## Channel delivery

With `S3ENDPOINT` set, aws-kinesis-local writes the records of each channel with an S3 destination to the bucket that its `BucketARN` names. The endpoint can be Amazon S3 or an S3-compatible server, and the bucket must already exist. aws-kinesis-local signs each request with `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, and it does not start when either is missing. It reads both only from the environment, which keeps them out of the process list.

A channel delivers the records that arrive after it becomes active. It buffers them for its data freshness interval, or for `DELIVERYINTERVALMS` when set. It then writes one object for each stream that has new records, under a key from its output key template and with its compression type.

| Record format | Object content |
| --- | --- |
| `JSON`, `STRING` | Each record on a line of its own |
| `BYTE_ARRAY` | The data of each record, unchanged, one after another |

A `JSON` channel delivers only records that parse as JSON, and a `STRING` channel delivers only valid UTF-8 text. For each record that fails, aws-kinesis-local writes its identifiers and the reason to the dead-letter location, and leaves the record out of the object. The dead-letter location is the bucket in `DeadLetterQueueS3Configuration`, under its `ErrorOutputPrefix`. Without that configuration, it is the destination bucket. The prefix defaults to `errors/`. Each error object holds one JSON line for each failed record, under the key `<prefix><channel name>/<channel ID>/<yyyy>/<MM>/<dd>/<HH>/<stream name>-<yyyy>-<MM>-<dd>-<HH>-<mm>-<UUID>.json`. AWS does not document the layout of these objects, and aws-kinesis-local uses the one below:

| Field | Content |
| --- | --- |
| `channelARN`, `streamARN` | ARNs of the channel and the stream |
| `shardId`, `sequenceNumber` | Shard and sequence number of the record |
| `approximateArrivalTimestamp` | Time when the record arrived, in ISO 8601 |
| `errorCode` | `FormatMismatch` |
| `errorMessage` | Why the record failed, such as `The record is not valid UTF-8 text.` |

An error object does not hold the record data. AWS documents the same for its dead-letter queue.

The database keeps the position of each channel in each shard. The position moves only after the S3 server accepts an object, so a failed upload keeps its records for the next attempt. aws-kinesis-local logs each failed upload at the `error` level. After a restart, each channel carries on from its saved position. After a reshard, a channel reads the child shards once it has delivered every record of their parents. Deleting a channel stops its delivery, and so does a reset that removes it.

The example below delivers each record within about a second of its arrival:

```bash
docker run -d -p 4567:4567 \
  -e S3ENDPOINT=http://s3.example.internal:9000 -e DELIVERYINTERVALMS=1000 \
  -e S3_ACCESS_KEY_ID -e S3_SECRET_ACCESS_KEY \
  docker.io/saidsef/aws-kinesis-local:latest
```

## Shutdown

aws-kinesis-local stops on `SIGTERM` and `SIGINT`. It reports that it is not ready, stops accepting connections, ends every `SubscribeToShard` response and lets the requests and channel uploads in progress finish. It closes the database last. When requests are still running after the time limit, which the `shutdownMs` option of `start()` sets, it closes their connections. A stream, consumer or channel that is in a transitional state when it stops finishes that change on the next start.

## Health check

aws-kinesis-local answers two health endpoints on `PORT`, and every other `GET` request returns a 403 error.

| Path | 200 | 503 |
| --- | --- | --- |
| `/healthz` | The server can read its database | The server cannot read its database |
| `/readyz` | The server can read its database and is not shutting down | The server cannot read its database, or shutdown has started |

The image health check requests `/healthz` every 60 seconds. It tries HTTP first and then HTTPS, so it also works with `--ssl`. The Helm chart and the Kustomize manifests use `/healthz` for the startup and liveness probes and `/readyz` for the readiness probe.

## Logs

aws-kinesis-local writes one JSON line to standard output for each request, and `docker logs` and `kubectl logs` show them. The start-up line, `Listening at`, is plain text. `LOGLEVEL` sets the least severe level that it writes, and each level also writes the levels above it in the table.

| Level | What it adds |
| --- | --- |
| `error` | Requests that fail with a 5xx status, failures of the background record expiry with the stack trace, and failed channel uploads |
| `warn` | Rejected requests, `SubscribeToShard` responses that end with an exception, and records that a channel sends to its dead-letter location |
| `info` | Every other API request, every `POST /_control/reset` and `POST /_control/clock` call, and every object that a channel delivers |
| `debug` | Health checks and CORS preflight requests |
| `trace` | The request body and the response body on every line |

A rejected `DescribeStream` request produces the line below:

```json
{"time":"2026-11-13T12:56:09.883Z","level":"warn","requestId":"9be13d3b-a82f-49d2-9702-4e288b46befa","method":"POST","path":"/","operation":"DescribeStream","stream":"nope","status":400,"errorType":"ResourceNotFoundException","errorMessage":"Stream nope under account 000000000000 not found.","durationMs":0.602}
```

| Field | Content |
| --- | --- |
| `requestId` | The `x-amzn-RequestId` response header, which the AWS SDKs and the AWS CLI report with each error |
| `method`, `path` | HTTP method and path, without the query string |
| `operation` | Operation in the `X-Amz-Target` header |
| `stream` | Stream that the request names in `StreamName`, `StreamARN`, `ConsumerARN` or `ResourceARN` |
| `status` | HTTP status code of the response |
| `errorType`, `errorMessage` | Error that the client received |
| `durationMs` | Milliseconds from the request headers to the end of the response. A `SubscribeToShard` line appears when its event stream ends. |
| `aborted` | `true` when the connection closed before the response ended |
| `error` | Stack trace of an unexpected failure |
| `request`, `response` | Decoded bodies, at the `trace` level only, with blobs as base64 text |
