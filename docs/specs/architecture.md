# Architecture

aws-kinesis-local is a single Node.js process with no runtime npm dependencies. It uses only the Node.js modules for HTTP, HTTP/2, TLS, cryptography, SQLite and zlib, so the npm package and the image ship compiled JavaScript and nothing else.

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | The package's public API: `start()`, `defaultOptions()`, and the `StartOptions` and `KinesisLocal` types |
| `src/cli.ts`, `src/arguments.ts` | Command-line flags, start-up and shutdown |
| `src/server.ts` | Defaults, listeners, protocol detection and store start-up |
| `src/handler.ts` | Request pipeline from headers to response |
| `src/errors.ts` | `KinesisError`, which carries the type, status code and message of an error response, and a helper for each common error type |
| `src/certificate.ts` | Self-signed certificate for `--ssl` |
| `src/model.ts`, `src/generated/model.ts` | Shape types and the shapes generated from the Smithy model |
| `src/validation/` | Type checks, constraint checks and the Coral member order |
| `src/protocol/` | CBOR codec, event stream encoder and the serialiser for responses |
| `src/kinesis/` | Sequence numbers, shard IDs and shard iterators |
| `src/operations/` | One module for each feature in [Supported operations](../supported-operations.md), and the registry in `index.ts` |
| `src/store/` | SQLite store and document types |
| `scripts/` | Model download and code generation |
| `model/` | Kinesis Smithy model that the generator reads |

## Request pipeline

`src/handler.ts` handles each request in the same order as kinesalite 3.3.3, so the same faulty request fails with the same error.

1. Add `x-amzn-RequestId` and `x-amz-id-2`, and answer CORS preflight requests.
2. Reject methods other than `POST` with an XML `AccessDeniedException`.
3. Read the content type and the `X-Amz-Target` header, and reject an empty body.
4. Reject unsupported content types, and parse JSON or CBOR.
5. Answer `application/json` requests with the Coral envelope that kinesalite returns.
6. Reject unknown services and operations.
7. Check that the request carries an `Authorization` header or the SigV4 query parameters.
8. Check member types, then member constraints, as [Request validation](validation.md) describes.
9. Decode blobs, run the operation and serialise its result for the request's protocol.

Each request runs synchronously on the event loop between the end of its body and its response, and `node:sqlite` is synchronous. Requests never interleave as a result, and aws-kinesis-local needs none of the per-stream locks that kinesalite took around its asynchronous LevelDB calls.

## HTTP/1.1 and HTTP/2 on one port

The AWS SDK for JavaScript v3 and the AWS SDK for Java open cleartext HTTP/2 connections with prior knowledge, which starts every connection with a fixed 24-byte preface. The listener reads the first bytes of each connection and compares them with that preface. It passes the socket to the HTTP/2 server when they match and to the HTTP/1.1 server otherwise, after it puts the bytes back on the socket.

The two servers read those bytes differently. The HTTP/2 server reads them from the paused socket on the next tick, so the listener leaves the socket paused. The HTTP/1.1 parser reads from the socket stream, so the listener resumes it. With `--ssl`, TLS negotiates the protocol through ALPN instead.

## Protocols

aws-kinesis-local accepts `application/x-amz-json-1.1` and `application/x-amz-cbor-1.1`, and answers in the protocol of the request. `src/protocol/serialize.ts` walks the output shape of each operation to convert timestamps and blobs.

| Protocol | Timestamps | Blobs |
| --- | --- | --- |
| JSON | Epoch seconds, with milliseconds as a fraction | Base64 text |
| CBOR | Epoch milliseconds as an integer | Byte strings |

The AWS SDK for Java is the only AWS SDK that sends CBOR to Kinesis. It writes request timestamps as CBOR tag 1 with epoch milliseconds, and reads response timestamps as epoch milliseconds, in `AwsCborProtocolFactory`. The CBOR decoder treats a tag 1 value above 10<sup>11</sup> as milliseconds and a smaller value as seconds. It also reads the indefinite-length maps, arrays and strings that Jackson writes.

## State transitions

Kinesis completes some changes asynchronously, and aws-kinesis-local models each one as a transition with a delay.

| Change | States | Delay |
| --- | --- | --- |
| Create a stream, consumer or channel | `CREATING` to `ACTIVE` | `--createStreamMs` |
| Delete a stream, consumer or channel | `DELETING` to removed | `--deleteStreamMs` |
| Reshard, change capacity mode or warm throughput, start or stop encryption, update a channel | `UPDATING` to `ACTIVE` | `--updateStreamMs` |

The store saves each pending transition in the document it changes, with its due time and the data it needs, such as the new shards of a stream. A transition that is due when aws-kinesis-local starts runs at once, and a later one runs at its due time. A stopped container never leaves a stream stuck in a transitional state.

## Sequence numbers and shard iterators

`src/kinesis/sequence.ts` keeps the kinesalite format, so clients that stored kinesalite sequence numbers can still parse and compare them.

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

`PutRecords` assigns counters in the same shard order as kinesalite, so the same batch gets the same counters on both. Shard iterators keep kinesalite's AES-256-CBC layout and key, so their length and their validation match kinesalite. They expire after 5 minutes.

## Resharding

`SplitShard` and `MergeShards` close the parent shards and create child shards that start one second later, as kinesalite does. `UpdateShardCount` splits the open shards at the uniform hash key boundaries of the target count, and then merges the pieces inside each target range. Kinesis also creates short-lived shards when it scales, and this approach gives every shard at most two parents, so the Kinesis Client Library can follow the lineage.

`ListShards` derives the start time of a shard from its starting sequence number and the end time from its ending sequence number. Its `ShardFilter` types use those times and the retention period, and clamp a time before the oldest shard to the creation of the stream.
