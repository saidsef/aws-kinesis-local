# Enhanced fan-out

## Consumers

`RegisterStreamConsumer` creates a consumer in `CREATING` and makes it `ACTIVE` after `--createStreamMs`. `DeregisterStreamConsumer` moves it to `DELETING` and removes it after `--deleteStreamMs`. A consumer ARN has the form `<stream ARN>/consumer/<name>:<creation time in epoch seconds>`, as in Kinesis.

| Limit | Value | Error |
| --- | --- | --- |
| Consumers for each stream | 20 | `LimitExceededException` |
| Consumers in `CREATING` across the account | 5 | `LimitExceededException` |
| Consumers with the same name on a stream | 1 | `ResourceInUseException` |

`DeleteStream` fails with `ResourceInUseException` while the stream has consumers, unless the request sets `EnforceConsumerDeletion`.

## Subscriptions

`SubscribeToShard` answers with status 200 and `application/vnd.amazon.eventstream`, and then writes event stream messages. The first message is an `initial-response` event, which the AWS SDK for Java waits for before it treats the subscription as open. Each later message is a `SubscribeToShardEvent`. Event payloads use the protocol of the request, so a CBOR client receives CBOR events with epoch millisecond timestamps.

| Behaviour | Value |
| --- | --- |
| Records in one event | Up to 1000 |
| Delivery after `PutRecord` or `PutRecords` | Immediate, because each write notifies the subscriptions on its shard |
| Check for new records without a notification | Every second |
| Event without records, to report the position | At least every 5 seconds |
| Length of a subscription | 5 minutes, after which aws-kinesis-local ends the response |
| Repeat subscription for the same consumer and shard | `ResourceInUseException` within 5 seconds of the last successful call. A later call takes over and ends the older subscription with a `ResourceInUseException` event. |

`ContinuationSequenceNumber` is the sequence number of the last record that the subscription delivered. A client resumes from it with `AFTER_SEQUENCE_NUMBER`, which is what the Kinesis Client Library does. Before the first record, it is a position one second before the next record to read, so `AFTER_SEQUENCE_NUMBER` still starts at that record.

When the subscription reaches the end of a closed shard, the last event carries `ChildShards` and no `ContinuationSequenceNumber`, and aws-kinesis-local ends the response. The Kinesis Client Library uses that event to move to the child shards.

When the consumer or the stream is removed during a subscription, aws-kinesis-local sends a `ResourceNotFoundException` exception message and ends the response.
