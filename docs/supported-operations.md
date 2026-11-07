# Supported operations

The image runs [kinesalite](https://github.com/mhart/kinesalite), which implements part of the [Kinesis Data Streams API](https://docs.aws.amazon.com/kinesis/latest/APIReference/API_Operations.html). kinesalite has not had a release since October 2020.

## Implemented operations

| Area | Operations |
| --- | --- |
| Streams | `CreateStream`, `DeleteStream`, `DescribeStream`, `DescribeStreamSummary`, `ListStreams` |
| Shards | `ListShards`, `SplitShard`, `MergeShards` |
| Records | `PutRecord`, `PutRecords`, `GetShardIterator`, `GetRecords` |
| Tags | `AddTagsToStream`, `RemoveTagsFromStream`, `ListTagsForStream` |
| Retention | `IncreaseStreamRetentionPeriod`, `DecreaseStreamRetentionPeriod` |

kinesalite answers every other operation with `UnknownOperationException`.

## Missing features

kinesalite does not implement the operations behind these features.

| Feature | Operations |
| --- | --- |
| Enhanced fan-out | `RegisterStreamConsumer`, `DescribeStreamConsumer`, `ListStreamConsumers`, `DeregisterStreamConsumer`, `SubscribeToShard` |
| On-demand capacity mode | `UpdateStreamMode` |
| Resharding to a target shard count | `UpdateShardCount` |
| Server-side encryption | `StartStreamEncryption`, `StopStreamEncryption` |
| Enhanced monitoring | `EnableEnhancedMonitoring`, `DisableEnhancedMonitoring` |
| Account limits | `DescribeLimits` |
| Resource-based policies | `GetResourcePolicy`, `PutResourcePolicy`, `DeleteResourcePolicy` |

To change the number of shards in a stream, call `SplitShard` and `MergeShards`.

## Differences from AWS

- `CreateStream` ignores `StreamModeDetails` and requires `ShardCount`, so every stream uses provisioned capacity.
- kinesalite ignores the `StreamARN` parameter. A request that names a stream by ARN alone fails with `ValidationException`, so pass `StreamName` instead.
- Streams are not scoped to a region. Every client sees the same streams, whatever region it sends.

## Kinesis Client Library

The Kinesis Client Library (KCL) 2.x and later reads with enhanced fan-out unless it is configured for polling, so a consumer with default settings cannot read from kinesalite. Configure polling with `PollingConfig`:

```java
RetrievalConfig retrievalConfig = configsBuilder.retrievalConfig()
    .retrievalSpecificConfig(new PollingConfig(streamName, kinesisClient));
```

The AWS SDK for Java 2.x configures `KinesisAsyncClient` for HTTP/2 by default, and kinesalite serves HTTP/1.1 only. Build the client that KCL uses with an HTTP/1.1 client:

```java
KinesisAsyncClient kinesisClient = KinesisAsyncClient.builder()
    .endpointOverride(URI.create("http://localhost:4567"))
    .httpClientBuilder(NettyNioAsyncHttpClient.builder().protocol(Protocol.HTTP1_1))
    .build();
```

KCL keeps its leases in DynamoDB and publishes metrics to CloudWatch, and this image provides neither. Point the KCL DynamoDB client at a local DynamoDB, such as [DynamoDB local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html) or [dynalite](https://github.com/mhart/dynalite), and turn metrics off with `MetricsLevel.NONE`.
