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

`start()` takes the same settings as the command-line flags, such as `path`, `shardLimit`, `createStreamMs`, `ssl` and `logLevel`, and the package includes TypeScript declarations for them. The server writes its [logs](configuration.md#logs) to the standard output of the test process, and `logLevel: 'error'` limits them to unexpected failures.

## Clearing streams

`POST /_control/reset` deletes every stream with its records, consumers, channels and policies, and returns the account settings to their defaults. A body of `{"stream": "orders"}` deletes only that stream, with its records, consumers and policies and the channels attached to it. The streams go at once, without the `DELETING` state, and an open `SubscribeToShard` response for a deleted stream ends with `ResourceNotFoundException`. The endpoint does not need a signature, and it answers with the names of the streams that it deleted:

```bash
curl -X POST http://localhost:4567/_control/reset -d '{"stream": "orders"}'
{"streams":["orders"]}
```

The object that `start()` returns offers the same operation as `reset()`, and `reset('orders')` clears one stream. Both return the names of the streams that they deleted.

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
