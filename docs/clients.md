# Clients

The AWS CLI and the AWS SDKs work with aws-kinesis-local once they point at its endpoint and sign their requests. They need no other configuration, because aws-kinesis-local serves JSON and CBOR over both HTTP/1.1 and HTTP/2. [Supported operations](supported-operations.md) lists the calls that it answers.

## Endpoints

| Deployment | Endpoint |
| --- | --- |
| `npx @saidsef/aws-kinesis-local` or `docker run -p 4567:4567` | `http://localhost:4567` |
| Helm chart, from inside the cluster | `http://<service>.<namespace>.svc` |
| Helm chart with `service.headless=true`, from inside the cluster | `http://<service>.<namespace>.svc:4567` |
| Kustomize manifests, from inside the cluster | `http://kinesis.<namespace>.svc:4567` |

The chart's Service takes the release name when that name contains `kinesis`, and is called `<release>-kinesis` otherwise. It listens on port 80 by default. The Kustomize Service is headless, and so is the chart's Service with `service.headless=true`. A headless Service has no cluster IP, so cluster DNS returns the pod addresses and clients connect to the container port, 4567.

## Credentials and region

aws-kinesis-local rejects unsigned requests with `MissingAuthenticationTokenException`. It does not check the signature, so any access key and secret key work. Streams are not scoped to a region, so the client can send any region.

## Node.js test suites

The npm package exports `start()`, which starts a server in the same process and returns its endpoint. Pass `port: 0` to take a free port, and call `close()` when the suite ends:

```javascript
// npm install --save-dev @saidsef/aws-kinesis-local @aws-sdk/client-kinesis
import { start } from '@saidsef/aws-kinesis-local';
import { KinesisClient, ListStreamsCommand } from '@aws-sdk/client-kinesis';

const server = await start({ port: 0, createStreamMs: 10 });
const kinesis = new KinesisClient({
  endpoint: server.endpoint,
  region: 'eu-west-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

console.log(await kinesis.send(new ListStreamsCommand({})));
kinesis.destroy();
await server.close();
```

`start()` takes the same settings as the command-line flags, such as `path`, `shardLimit`, `createStreamMs`, `ssl` and `logLevel`, and the package includes TypeScript declarations for them. Its `backend` option keeps the state in a datastore of your choice, as [Storage backends](#storage-backends) describes. The server writes its [logs](configuration.md#logs) to the standard output of the test process, and `logLevel: 'error'` limits them to unexpected failures.

## Clearing streams

`POST /_control/reset` deletes every stream with its records, consumers, channels and policies, returns the account settings to their defaults and sets the clock back to real time. A body of `{"stream": "orders"}` deletes only that stream, with its records, consumers and policies and the channels attached to it. The streams go at once, without the `DELETING` state, and an open `SubscribeToShard` response for a deleted stream ends with `ResourceNotFoundException`. The endpoint does not need a signature, and it answers with the names of the streams that it deleted:

```bash
curl -X POST http://localhost:4567/_control/reset -d '{"stream": "orders"}'
{"streams":["orders"]}
```

The object that `start()` returns offers the same operation as `reset()`, and `reset('orders')` clears one stream. `reset()` resolves to the names of the streams that it deleted.

## Moving the clock

`POST /_control/clock` moves the clock of aws-kinesis-local forward. A test can then reach an expiry without waiting for it. The clock follows real time until the first call. A body of `{"advanceSeconds": 86400}` moves it forward by one day. The endpoint does not need a signature, and it answers with the number of seconds that the clock is ahead of real time:

```bash
curl -X POST http://localhost:4567/_control/clock -d '{"advanceSeconds": 86400}'
{"offsetSeconds":86400}
```

Each time value that the API reports or compares comes from the clock:

- A shard iterator expires once the clock passes five minutes after `GetShardIterator` created it.
- `GetRecords` and `SubscribeToShard` leave out records older than the retention period, and `ListShards` measures its trim horizon from the clock.
- A stream, consumer or channel in a transitional state moves on once the clock passes its due time. The endpoint runs each of these transitions before it answers, and the next request sees the new state.
- A `SubscribeToShard` response ends once the clock passes five minutes after its call. The 5-second wait between two calls also follows the clock.
- Record arrival times, creation timestamps, sequence numbers and the dates in channel object keys come from the clock.

The clock moves only forward. `advanceSeconds` takes a number from 0 to 315360000, which is ten years, and a call with 0 reports the offset without moving the clock. The database keeps the offset, and the clock remains ahead after a restart with `--path`. A full reset sets the clock back to real time, and a reset of one stream leaves it where it is. Log lines, the delivery interval of channels and the signatures of their S3 requests keep real time.

The object that `start()` returns offers the same operation as `advanceClock(seconds)`. It resolves to the offset in seconds, and rejects with a `RangeError` for a number outside that range.

## Storage backends

`start()` keeps streams, records, consumers, channels, policies, account settings and the clock in SQLite. Its `backend` option takes any object that implements the `StorageBackend` interface instead. The package exports that interface with its document and record types. A backend can then keep the state of aws-kinesis-local in any datastore. Each method returns a promise, because a backend may need to wait for its datastore:

```typescript
import { start, type DocumentKind, type StorageBackend, type StoredDocument } from '@saidsef/aws-kinesis-local';

class MapBackend implements StorageBackend {
  documents = new Map<string, StoredDocument>();

  async readDocuments() {
    return [...this.documents.values()];
  }

  async putDocument(document: StoredDocument) {
    this.documents.set(`${document.kind} ${document.key}`, document);
  }

  async deleteDocument(kind: DocumentKind, key: string) {
    this.documents.delete(`${kind} ${key}`);
  }

  // putRecords(), readRecords() and the other methods in the table below
}

const server = await start({ port: 0, backend: new MapBackend() });
```

[`test/backends/map.ts`](https://github.com/saidsef/aws-kinesis-local/blob/main/test/backends/map.ts) holds a complete backend built on `Map` objects. Each method does the work below.

| Method | Work |
| --- | --- |
| `readDocuments()` | Returns every document that the backend holds. `start()` calls it once, before it listens. |
| `putDocument(document)` | Saves a document, and replaces any document with the same kind and key. |
| `deleteDocument(kind, key)` | Deletes a document. A missing document is not an error. |
| `putRecords(stream, records)` | Saves the stream document and the records of one `PutRecord` or `PutRecords` call. |
| `readRecords(query)` | Returns up to `query.limit` records of one shard in sequence number order. A query starts at `from` or after `after`, and can skip records that arrived before `arrivedSince`. |
| `expireRecords(stream, shardIx, arrivedBefore, limit)` | Deletes up to `limit` of the oldest records of one shard that arrived before `arrivedBefore`, and returns how many it deleted. |
| `deleteRecords(stream)` | Deletes every record of a stream. |
| `readDeliveryPositions(channelId, stream)` | Returns the sequence number of the last record that a channel delivered from each shard, keyed by shard index. |
| `putDeliveryPositions(channelId, stream, positions)` | Saves the positions of the shards in `positions` and keeps those of other shards. |
| `deleteDeliveryPositions(channelId)` | Deletes the positions of a channel for every stream. |
| `ping()` | Resolves when the datastore answers. `/healthz` returns 503 while it rejects. |

A backend follows these rules:

- A document has a `kind`, a `key` and a `value`. The kinds are `stream`, `consumer`, `channel`, `policy`, `settings` and `clock`.
- The settings document always has the key `account`. The clock document always has the key `offset`.
- Each value is plain JSON. A policy is a string, and the clock value is its offset in milliseconds.
- The store passes a copy of each document and never changes an object after it passes it to a backend. It also copies each document that `readDocuments()` returns. A backend can keep the objects that it receives.
- Sequence numbers have the same number of digits, and a backend can compare them as text.
- A record carries its arrival time in seconds, with milliseconds as a fraction. Its sequence number carries the same time in whole seconds, and `arrivedBefore` is always a whole number of seconds.
- A rejected promise ends the request that made the call with `InternalFailure`.
- The store runs the calls for each stream one at a time, in the order that requests arrive. A backend does not need locks of its own.
- `putRecords()` saves its stream document and records in one write where the datastore allows it. A backend that cannot do that writes the document first, as [Storage](specs/storage.md#order-of-backend-calls) explains.
- `close()` waits for backend calls in progress and leaves the backend open. Close the datastore client after `close()` resolves.
- The `path` option belongs to the SQLite backend, and `start()` rejects it together with `backend`.

## Storage backend tests

The package exports the test suite that the SQLite backend passes, as `storageBackendTests` from `@saidsef/aws-kinesis-local/testing`. Each entry has a name and a `run(backend)` function, which throws an assertion error when the backend breaks a rule. Each test needs a new, empty backend, which `createEmptyBackend()` stands for below:

```typescript
import { test } from 'node:test';
import { storageBackendTests } from '@saidsef/aws-kinesis-local/testing';

for (const { name, run } of storageBackendTests) {
  test(name, async () => {
    await run(await createEmptyBackend());
  });
}
```

The repository runs the suite against SQLite and against the backend in `test/backends/map.ts`.

## AWS CLI

```bash
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=eu-west-1

aws --endpoint-url http://localhost:4567 kinesis create-stream --stream-name example --shard-count 1
aws --endpoint-url http://localhost:4567 kinesis put-record --stream-name example --partition-key key --data aGVsbG8=
aws --endpoint-url http://localhost:4567 kinesis list-streams
```

## AWS SDK for JavaScript

The Kinesis client in the AWS SDK for JavaScript v3 sends requests over HTTP/2, which aws-kinesis-local serves on the same port as HTTP/1.1:

```javascript
// npm install @aws-sdk/client-kinesis
const { KinesisClient, ListStreamsCommand } = require('@aws-sdk/client-kinesis');

const kinesis = new KinesisClient({
  endpoint: 'http://localhost:4567',
  region: 'eu-west-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

kinesis.send(new ListStreamsCommand({})).then(console.log);
```

See the [AWS SDK for JavaScript Kinesis reference](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/kinesis/).

## Python

```python
import boto3

kinesis = boto3.client(
    "kinesis",
    endpoint_url="http://localhost:4567",
    region_name="eu-west-1",
    aws_access_key_id="test",
    aws_secret_access_key="test",
)
print(kinesis.list_streams()["StreamNames"])
```

boto3 reads enhanced fan-out events from `subscribe_to_shard` over HTTP/1.1.

## AWS SDK for Java

The AWS SDK for Java sends CBOR by default, and its asynchronous Kinesis client uses HTTP/2. aws-kinesis-local supports both, so the default client works without `AWS_CBOR_DISABLE` or an HTTP/1.1 override. CBOR responses carry timestamps as epoch milliseconds, which is what the SDK expects.

## Kinesis Client Library

KCL consumers work in polling and enhanced fan-out mode, and need a local DynamoDB for their leases. See [Kinesis Client Library](supported-operations.md#kinesis-client-library).
