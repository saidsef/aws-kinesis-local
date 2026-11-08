# Supported operations

aws-kinesis-local implements all 45 operations in the [Kinesis Data Streams API](https://docs.aws.amazon.com/kinesis/latest/APIReference/API_Operations.html) and checks every request against the Smithy model that AWS publishes for Kinesis. [Request validation](specs/validation.md) describes how it generates those checks.

## Operations

| Feature | Operations |
| --- | --- |
| Streams | `CreateStream`, `DeleteStream`, `DescribeStream`, `DescribeStreamSummary`, `ListStreams` |
| Records | `PutRecord`, `PutRecords`, `GetShardIterator`, `GetRecords` |
| Shards | `ListShards`, `SplitShard`, `MergeShards`, `UpdateShardCount` |
| Retention | `IncreaseStreamRetentionPeriod`, `DecreaseStreamRetentionPeriod` |
| Tags | `AddTagsToStream`, `RemoveTagsFromStream`, `ListTagsForStream`, `TagResource`, `UntagResource`, `ListTagsForResource` |
| Capacity and limits | `UpdateStreamMode`, `UpdateMaxRecordSize`, `UpdateStreamWarmThroughput`, `UpdateStreamRecordDistributionStrategy` |
| Enhanced fan-out | `RegisterStreamConsumer`, `DescribeStreamConsumer`, `ListStreamConsumers`, `DeregisterStreamConsumer`, `SubscribeToShard` |
| Encryption and monitoring | `StartStreamEncryption`, `StopStreamEncryption`, `EnableEnhancedMonitoring`, `DisableEnhancedMonitoring` |
| Account settings and resource policies | `DescribeLimits`, `DescribeAccountSettings`, `UpdateAccountSettings`, `GetResourcePolicy`, `PutResourcePolicy`, `DeleteResourcePolicy` |
| Channels | `CreateChannel`, `DeleteChannel`, `DescribeChannel`, `ListChannels`, `UpdateChannel` |

Every operation that takes a stream name also accepts the stream ARN in `StreamARN`. aws-kinesis-local serves JSON and CBOR over HTTP/1.1 and HTTP/2 on the same port.

## Differences from AWS

aws-kinesis-local keeps state for every operation, but it does not run the AWS services behind some of them.

| Area | Behaviour |
| --- | --- |
| Authentication | aws-kinesis-local requires an `Authorization` header or the SigV4 query parameters, but it does not check the signature. Any access key and secret key work. |
| Regions and accounts | Streams are not scoped to a region or an account. aws-kinesis-local finds a stream by the name in its ARN and ignores the region and account in the ARN. |
| Throughput | aws-kinesis-local never returns `ProvisionedThroughputExceededException` and does not enforce the per-second call limits of each operation. |
| On-demand capacity | An on-demand stream starts with 4 shards and does not scale by itself. |
| Encryption | aws-kinesis-local records the encryption type and key ID and reports `EncryptionType` on records, but it does not call KMS or encrypt the data. |
| Enhanced monitoring | aws-kinesis-local records the shard-level metrics that are enabled, but it does not publish them to CloudWatch. |
| Resource policies | aws-kinesis-local stores policies and returns them, but it does not enforce them. |
| Channels | aws-kinesis-local records the channel configuration and its status, but it does not deliver records to Amazon S3 or Amazon S3 Tables. |
| Account settings | `UpdateAccountSettings` enables and disables the minimum throughput billing commitment immediately, without a minimum commitment window. |
| Error messages | The wording of some error messages can differ from AWS. |

## Kinesis Client Library

The Kinesis Client Library (KCL) works in both polling and enhanced fan-out mode, with the default settings of the AWS SDK for Java: CBOR and HTTP/2. Point the Kinesis client at aws-kinesis-local:

```java
KinesisAsyncClient kinesisClient = KinesisAsyncClient.builder()
    .endpointOverride(URI.create("http://localhost:4567"))
    .region(Region.EU_WEST_1)
    .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("test", "test")))
    .build();
```

KCL keeps its leases in DynamoDB and publishes metrics to CloudWatch, and aws-kinesis-local provides neither. Point the KCL DynamoDB client at a local DynamoDB, such as [DynamoDB local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html), and turn metrics off with `MetricsLevel.NONE`. The release workflow runs [a KCL consumer](https://github.com/saidsef/aws-kinesis-local/tree/main/test/kcl) in both modes against the image before it publishes a release.
