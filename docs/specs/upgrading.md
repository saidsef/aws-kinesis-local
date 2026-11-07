# Upgrading from kinesalite

The Docker image ran kinesalite 3.3.3 until aws-kinesis-local replaced it. For the 17 operations that kinesalite implements, aws-kinesis-local returns the same status, headers and body to the same request. The exceptions are responses where kinesalite contradicts the current Kinesis API or has a defect, and fields that the current API adds to a response.

## Data

aws-kinesis-local does not carry over the streams that a kinesalite image saved under `/data`. It keeps its own SQLite database beside the LevelDB files and does not read them. Recreate the streams after the upgrade, or keep the old image until the data is no longer needed.

Images published before v2026.06 started kinesalite without its flags, so they kept streams in memory and saved nothing under `/data`.

## What stays the same

| Area | Behaviour |
| --- | --- |
| Interface | Port 4567 serves plain HTTP, and the environment variables, flags and defaults are unchanged |
| ARNs | `arn:aws:kinesis:<region>:<account>:stream/<name>`, with the region from `AWS_REGION` or `AWS_DEFAULT_REGION` and the account from `AWS_ACCOUNT_ID` |
| Errors | Error types and messages, `SerializationException` messages under `Message`, and the XML responses for unsupported methods and content types |
| Protocol checks | The order of the checks for content type, target, body, authentication, types and constraints |
| Sequence numbers | The same format, counters and shard assignment for the same requests |
| Shard iterators | The same encryption, length and validation |
| Headers | `x-amzn-RequestId`, `x-amz-id-2` and the CORS headers |

## Added response fields

Clients that read JSON ignore fields they do not expect, and the AWS SDKs already know these fields from the model.

| Operation | Added fields |
| --- | --- |
| `DescribeStream`, `DescribeStreamSummary` | `StreamModeDetails` |
| `DescribeStreamSummary` | `MaxRecordSizeInKiB`, `WarmThroughput`, `RecordDistributionStrategy` and `ChannelCount`, when they apply |
| `ListStreams` | `StreamSummaries`, and `NextToken` when more streams remain |
| `GetRecords` | `ChildShards` at the end of a closed shard |
| `PutRecord`, `PutRecords`, `GetRecords` | `EncryptionType` while encryption is on |

`ConsumerCount` in `DescribeStreamSummary` counts the registered consumers, and kinesalite always returned 0.

## Changed responses

| Request | kinesalite 3.3.3 | aws-kinesis-local | Reason |
| --- | --- | --- | --- |
| An operation that kinesalite does not implement | `UnknownOperationException` | The operation runs | aws-kinesis-local implements all 45 operations |
| A body larger than 7 MiB | 413 | Accepted up to 16 MiB | Records can be up to 10 MiB |
| `CreateStream` with more than 100000 shards | `ValidationException` | `LimitExceededException` | The model sets no maximum, so the shard limit applies |
| `DescribeStream` with `Limit` or `ExclusiveStartShardId` | Ignores both | Pages the shards, with a default limit of 100 | Kinesis pages shards |
| CBOR responses | Epoch seconds and base64 text | Epoch milliseconds and byte strings | The AWS SDK for Java reads CBOR timestamps as milliseconds and blobs as bytes |
| `GetShardIterator` with `AT_TIMESTAMP` after the last record | Never answers | An iterator at the tip of the shard | kinesalite waits for a record that never arrives |
| `RetentionPeriodHours` of 0 | `ValidationException` | `InvalidArgumentException` for the 24-hour minimum | The model sets no range |
| `RetentionPeriodHours` from 169 to 8760 | `ValidationException` | Accepted | Kinesis allows up to 8760 hours |
| `AddTagsToStream` with 11 to 50 tags | `ValidationException` | Accepted | Kinesis allows 50 tags for each stream |
| `ListTagsForStream` with a limit from 11 to 50 | `ValidationException` | Accepted | The model allows up to 50 |
| `SplitShard` or `MergeShards` on a closed shard | Accepted, and the shard is split again | `InvalidArgumentException` | A closed shard cannot be resharded |
| `ListShards` with only `NextToken` | The process exits with an unhandled `ReadError` | Reads the token, or returns `InvalidArgumentException` for a token it did not issue | kinesalite ignores the token and looks up a stream without a name |
