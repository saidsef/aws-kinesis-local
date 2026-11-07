# Clients

The AWS CLI and the AWS SDKs work with kinesalite once they point at its endpoint and sign their requests. [Supported operations](supported-operations.md) lists the calls that kinesalite answers.

## Endpoints

| Deployment | Endpoint |
| --- | --- |
| `docker run -p 4567:4567` | `http://localhost:4567` |
| Helm chart, from inside the cluster | `http://<service>.<namespace>.svc` |
| Kustomize manifests, from inside the cluster | `http://kinesis.<namespace>.svc` |

The chart's Service takes the release name when that name contains `kinesis`, and is called `<release>-kinesis` otherwise. Both Services listen on port 80 by default.

## Credentials and region

kinesalite rejects unsigned requests with `MissingAuthenticationTokenException`. It does not check the signature, so any access key and secret key work. Streams are not scoped to a region, so the client can send any region.

## AWS CLI

```bash
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=eu-west-1

aws --endpoint-url http://localhost:4567 kinesis create-stream --stream-name example --shard-count 1
aws --endpoint-url http://localhost:4567 kinesis put-record --stream-name example --partition-key key --data aGVsbG8=
aws --endpoint-url http://localhost:4567 kinesis list-streams
```

## AWS SDK for JavaScript

The Kinesis client in the AWS SDK for JavaScript v3 sends requests over HTTP/2, and kinesalite serves HTTP/1.1 only. Give the client an HTTP/1.1 request handler:

```javascript
// npm install @aws-sdk/client-kinesis @smithy/node-http-handler
const { KinesisClient, ListStreamsCommand } = require('@aws-sdk/client-kinesis');
const { NodeHttpHandler } = require('@smithy/node-http-handler');

const kinesis = new KinesisClient({
  endpoint: 'http://localhost:4567',
  region: 'eu-west-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  requestHandler: new NodeHttpHandler(),
});

kinesis.send(new ListStreamsCommand({})).then(console.log);
```

See the [AWS SDK for JavaScript Kinesis reference](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/kinesis/).

## Kinesis Client Library

KCL consumers need polling mode, an HTTP/1.1 Kinesis client and a local DynamoDB. See [Kinesis Client Library](supported-operations.md#kinesis-client-library).
