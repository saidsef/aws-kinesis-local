# Architecture

aws-kinesis-local is a single Node.js process with no runtime npm dependencies. It uses only the Node.js modules for HTTP, HTTP/2, TLS, cryptography, SQLite and zlib, so the npm package and the image ship compiled JavaScript and nothing else.

[![AWS clients connect over HTTP/1.1 or HTTP/2, with or without TLS, on the same port. The listener passes each connection to the matching server. The request handler validates each request against the generated model and runs the operation. The store keeps its data in SQLite or in a storage backend that a caller passes to start().](architecture.svg)](architecture.svg)

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | The package's public API: `start()`, `defaultOptions()`, the `StartOptions` and `KinesisLocal` types, and the `StorageBackend` interface with its document and record types |
| `src/testing.ts` | Test suite for storage backends, which the package exports as `@saidsef/aws-kinesis-local/testing` |
| `src/cli.ts`, `src/arguments.ts` | Command-line flags, start-up and shutdown |
| `src/server.ts` | Defaults, listeners, protocol detection and store start-up |
| `src/handler.ts` | Request pipeline from headers to response |
| `src/errors.ts` | `KinesisError`, which carries the type, status code and message of an error response, and a helper for each common error type |
| `src/logger.ts` | Log levels and the writer of JSON log lines |
| `src/certificate.ts` | Self-signed certificate for TLS connections |
| `src/model.ts`, `src/generated/model.ts` | Shape types and the shapes generated from the Smithy model |
| `src/validation/` | Type checks, constraint checks and the Coral member order |
| `src/protocol/` | CBOR codec, event stream encoder and the serialiser for responses |
| `src/kinesis/` | Sequence numbers, shard IDs and shard iterators |
| `src/operations/` | One module for each feature in [Supported operations](../supported-operations.md), and the registry in `index.ts` |
| `src/store/` | Store, storage backend interface, SQLite backend and document types |
| `src/delivery/` | Signed S3 client, object keys and the delivery loop for channels |
| `scripts/` | Model download and code generation |
| `model/` | Kinesis Smithy model that the generator reads |

## Request pipeline

`src/handler.ts` handles each request in the order below, so the same faulty request always fails with the same error.

1. Add `x-amzn-RequestId` and `x-amz-id-2`, and answer CORS preflight requests.
2. Answer `GET /healthz`, `GET /readyz`, `POST /_control/reset` and `POST /_control/clock`, and reject every other request that is not a `POST` with an XML `AccessDeniedException`.
3. Read the content type and the `X-Amz-Target` header, and reject an empty body.
4. Reject unsupported content types, and parse JSON or CBOR.
5. Answer `application/json` requests with the Coral envelope.
6. Reject unknown services and operations.
7. Check that the request carries an `Authorization` header or the SigV4 query parameters.
8. Check member types, then member constraints, as [Request validation](validation.md) describes.
9. Decode blobs, run the operation and serialise its result for the request's protocol.

An operation changes the documents in memory before its first `await` and then waits for the storage backend. Requests can interleave while they wait. The store runs the backend calls for each stream one at a time in the order they arrive. Requests to one stream then take effect in that order, whichever backend is in use. [Storage](storage.md#order-of-backend-calls) describes the queues.

## Request logs

The handler assigns a request ID and sets `x-amzn-RequestId` as soon as headers arrive. A response that the request size limit rejects carries the ID as well. The handler writes the log line for a request when the response closes. The duration then covers the whole response, and a `SubscribeToShard` line covers the whole event stream. A subscription reports the exception that ends its event stream to the handler. Its line then carries an error type, although the status is 200.

The outcome of a request sets the level of its line. A 5xx status logs at `error`, a 4xx status or an exception event at `warn`, a health check or a CORS preflight request at `debug`, and any other request at `info`. Health checks log at `debug` because Kubernetes probes call them every few seconds.

The `path` field leaves out the query string, because a presigned request carries its credential and signature there. The handler never logs headers for the same reason. At the `trace` level, `request` holds the body after JSON or CBOR decoding and before validation, or the raw text of a body that does not parse. The logger writes blobs as base64 and CBOR big integers as strings, because JSON has neither byte strings nor big integers. The logger leaves out the event stream of a `SubscribeToShard` response.

## HTTP/1.1, HTTP/2 and TLS on the same port

The AWS SDK for JavaScript v3 and the AWS SDK for Java open cleartext HTTP/2 connections with prior knowledge, which starts every connection with a fixed 24-byte preface. A TLS connection starts with a handshake record, whose first byte is 22, as [RFC 8446, section 5.1](https://www.rfc-editor.org/rfc/rfc8446#section-5.1) defines. The listener reads the first bytes of each connection and puts them back on the socket. It then passes a TLS connection to the TLS server, a connection that starts with the HTTP/2 preface to the HTTP/2 server, and any other connection to the HTTP/1.1 server.

The servers read those bytes differently. The HTTP/2 and TLS servers read them from the paused socket on the next tick, so the listener leaves the socket paused. The HTTP/1.1 parser reads from the socket stream, so the listener resumes it. The TLS server negotiates HTTP/2 or HTTP/1.1 through ALPN and passes each request to the same handler. With `--ssl`, the TLS server listens on the port itself, and a connection that does not open with a TLS handshake fails.

## Protocols

aws-kinesis-local accepts `application/x-amz-json-1.1` and `application/x-amz-cbor-1.1`, and answers in the protocol of the request. `src/protocol/serialize.ts` walks the output shape of each operation to convert timestamps and blobs.

| Protocol | Timestamps | Blobs |
| --- | --- | --- |
| JSON | Epoch seconds, with milliseconds as a fraction | Base64 text |
| CBOR | Epoch milliseconds as an integer | Byte strings |

The AWS SDK for Java is the only AWS SDK that sends CBOR to Kinesis. It writes request timestamps as CBOR tag 1 with epoch milliseconds, and reads response timestamps as epoch milliseconds, in `AwsCborProtocolFactory`. The CBOR decoder treats a tag 1 value above 10<sup>11</sup> as milliseconds and a smaller value as seconds. It also reads the indefinite-length maps, arrays and strings that Jackson writes.

## Health checks and shutdown

`/healthz` calls `ping()` on the storage backend, which runs a query against SQLite in the default backend. A 200 then means that the event loop and the datastore both respond. `/readyz` also fails as soon as shutdown starts.

`close()` sets the store to draining, which fails `/readyz` and ends every subscription. It then stops the listener, sends a `GOAWAY` frame to each HTTP/2 session and waits for the requests in progress. The server counts a request from its headers until its response closes. That count works the same for HTTP/1.1, HTTP/2 and TLS, where the sockets that the listener tracks are not the sockets that carry the requests. A request that arrives on an open HTTP/1.1 connection during shutdown still runs, and its response carries `Connection: close`. When the count reaches zero or `shutdownMs` passes, `close()` waits for backend calls in progress, closes the SQLite backend and destroys remaining sockets. It leaves open a backend that a caller passed to `start()`.

## State transitions

Kinesis completes some changes asynchronously, and aws-kinesis-local models each one as a transition with a delay.

| Change | States | Delay |
| --- | --- | --- |
| Create a stream, consumer or channel | `CREATING` to `ACTIVE` | `--createStreamMs` |
| Delete a stream, consumer or channel | `DELETING` to removed | `--deleteStreamMs` |
| Reshard, change capacity mode or warm throughput, start or stop encryption, update a channel | `UPDATING` to `ACTIVE` | `--updateStreamMs` |

The store saves each pending transition in the document it changes, with its due time and the data it needs, such as the new shards of a stream. A transition that is due when aws-kinesis-local starts runs at once, and a later one runs at its due time. A stopped container never leaves a stream stuck in a transitional state.

A reset skips the `DELETING` state. It cancels the pending transitions of the documents it deletes, removes them from memory at once and then waits for the backend to delete them. A reset of one stream also removes the channels attached to it, because `DeleteStream` refuses a stream that has channels. The store reports each stream as deleted before it removes the consumers, and an open `SubscribeToShard` response ends with `ResourceNotFoundException` for the stream. A consumer ARN ends with its creation time in seconds, and a test that registers a consumer again after a reset can get the same ARN. Removing a consumer clears its last `SubscribeToShard` call, and the 5-second wait between subscriptions does not apply to the new consumer.

## Clock

The store reads the time through `now()`, which adds an offset to `Date.now()`. Operations, transitions, subscriptions and channel deliveries all read the time from the store. `POST /_control/clock` then moves all of them at once. The backend keeps the offset in the clock document. A restart with `--path` then keeps the clock where a test left it, and the shard iterators and pending transitions from before the restart still match it.

Moving the clock runs every pending transition that falls due, in order of due time, before the endpoint answers. The store then sets timers for the remaining transitions again from the new time. Each open subscription also sets its 5-minute timer again, and ends at once when the clock has passed it.

The clock never moves back while streams exist, because each shard iterator and each `LATEST` position carries the time when it was made. A full reset deletes every stream, consumer and channel before it sets the clock back to real time. Sequence numbers remain in order whatever the clock does, because the counter comes before the record time in each sequence number.

Log lines, S3 request signatures and the TLS certificate keep real time, because a log collector, an S3 server and a TLS client compare them with their own clocks. The delivery interval of a channel and the background record expiry run on real-time timers. Reads already leave out records that the clock has expired. The background expiry then only frees space.

## Sequence numbers and shard iterators

`src/kinesis/sequence.ts` builds and parses sequence numbers in the format below.

| Hex digits | Content of a version 2 sequence number |
| --- | --- |
| 1 | Version marker `2` |
| 2 to 10 | Shard creation time in seconds |
| 11 | Last hex digit of the shard index |
| 12 to 27 | Counter, which every group of five shards shares |
| 28 to 29 | Reserved byte, always `00` |
| 30 to 38 | Record time in seconds |
| 39 to 46 | Shard index |
| 47 | Version marker `2` |

`PutRecords` assigns counters in a fixed shard order that depends on the number of shards. Shard iterators are encrypted with AES-256-CBC and a fixed key, so the server can validate them after a restart. They expire after 5 minutes.

## Resharding

`SplitShard` and `MergeShards` close the parent shards and create child shards that start one second later. `UpdateShardCount` splits the open shards at the uniform hash key boundaries of the target count, and then merges the pieces inside each target range. Kinesis also creates short-lived shards when it scales, and this approach gives every shard at most two parents, so the Kinesis Client Library can follow the lineage.

`ListShards` derives the start time of a shard from its starting sequence number and the end time from its ending sequence number. Its `ShardFilter` types use those times and the retention period, and clamp a time before the oldest shard to the creation of the stream.

## S3 client

`src/delivery/s3.ts` uploads objects with `node:http`, `node:https` and `node:crypto`. It signs each `PutObject` request with Signature Version 4, as [Signature calculations for the Authorization header](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html) describes, and signs every header that it sends. It puts the bucket name in the path, as in `/<bucket>/<key>`, and not in the host name. A bucket on a local server then does not need a DNS name of its own. A path in the endpoint, such as `/storage`, goes in front of the bucket name.

A failed upload rejects with `S3Error`, which carries the status code and the `Code` element of the S3 error response. A response without an S3 error body, such as a 502 from a proxy, leaves the code empty.

## Object keys

`src/delivery/key-template.ts` checks output key templates and builds object keys from them, as [S3 output key template for Amazon S3 delivery](https://docs.aws.amazon.com/streams/latest/dev/data-delivery-s3-key-template.html) describes. `CreateChannel` rejects a template that breaks a rule on that page. Its length check expands the template with the channel name, the channel ID and the longest stream name of the channel.

A channel without a template uses the default template from that page. The date and time variables expand in UTC. Each key carries a unique suffix of 37 characters, which is a hyphen and a random UUID. The AWS documentation limits the suffix to 38 characters and does not say where it goes. aws-kinesis-local puts it in front of the extension, and every key then ends with the extension that its template sets.

## Channel delivery

`src/delivery/channel.ts` runs only when `start()` receives an S3 endpoint. It keeps one timer for each channel that is `ACTIVE` or `UPDATING` and has an S3 destination. The store announces each activation and each removal of a channel, so the delivery loop needs no polling. A timer fires after the delivery interval, delivers each stream of the channel in turn and then starts the next interval. One channel never runs two deliveries at once.

The records table is the buffer. The `activateChannel` transition saves the time when a channel first becomes active, and a shard without a saved position starts at the first record that arrived after that time. A delivery reads the shards of a stream in index order, from the saved position of each. Resharding appends child shards after their parents, so this order reads every parent before its children.

Before an upload, a delivery checks each record of a `JSON` or `STRING` stream and moves the records that fail into an error object. It uploads the error object first and the destination object second. A failed destination upload then repeats only the error object on the next attempt, and never the delivered records.

A delivery reads rows in pages and ends an object at a size limit, so a backlog after an outage becomes several objects. An upload that gets no response fails after a timeout. The store saves new positions only after the S3 server accepts every object of a batch. The SQLite backend saves them in one transaction. The next interval reads the records of a failed upload again.

A reset can replace a channel with a new one under the same ARN. Each timer holds the channel document that it started with, and stops when the store no longer holds that document. Positions belong to the channel ID, and removing a channel deletes them. Shutdown stops the timers and waits for the uploads in progress, within `shutdownMs`, before it closes the store.
