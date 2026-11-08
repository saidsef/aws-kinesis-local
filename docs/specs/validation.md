# Request validation

aws-kinesis-local checks every request against the Smithy model that AWS publishes for Kinesis. It reports failures in the format and order of the Coral framework behind Kinesis.

## Model

`model/kinesis-2013-12-02.json` is the [Kinesis model from aws/api-models-aws](https://github.com/aws/api-models-aws/tree/main/models/kinesis/service/2013-12-02). Its `metadata` block records the source URL and the commit. `npm run model -- <commit>` downloads the model at that commit and removes documentation, examples, smoke tests and endpoint rules, which aws-kinesis-local does not use.

## Generator

`scripts/generate.ts` reads the model and writes `src/generated/model.ts`, which git ignores. The test, typecheck and build commands generate it first.

| Generated value | Content |
| --- | --- |
| `serviceTarget` | The target prefix, `Kinesis_20131202` |
| `operations` | Input shape, output shape and errors of each operation |
| `shapes` | Every shape that an input or output reaches, with structure members in model order and their `required` flags, list and map members, string length, pattern and enum values, number ranges and blob length |

## Type checks

Before it checks any constraint, aws-kinesis-local walks the input shape and converts each member.

- It drops members that the shape does not define, and members whose value is null.
- It truncates integers towards negative infinity and caps them at 2147483647.
- It reports the first mismatched type as `SerializationException`, with the Coral message under `Message`, such as `class java.lang.String can not be converted to an Integer`.
- It checks that base64 text has a length that is a multiple of four, valid characters and valid padding.
- It accepts CBOR byte strings for blobs and CBOR dates for timestamps.

## Constraint checks

It then checks each member in turn and collects up to ten failures into one `ValidationException`, such as `2 validation errors detected: Value null at 'shardCount' failed to satisfy constraint: Member must not be null; ...`.

| Order | Check | Source in the model |
| --- | --- | --- |
| 1 | Must not be null | `required`, and the rules below |
| 2 | Regular expression | `pattern`, shown without its anchors and outer group |
| 3 | Minimum length | `length.min`, when it is above zero |
| 4 | Maximum length | `length.max` |
| 5 | Minimum value | `range.min` |
| 6 | Maximum value | `range.max` |
| 7 | Enum values | `enum` |
| 8 | Length or enum of every list member, or length of every map key and value | Constraints of the member shapes |
| 9 | Members of nested structures | Nested shapes, with paths such as `records.1.member.partitionKey` |

Failures show the value as Coral prints it. A blob appears as `java.nio.HeapByteBuffer[pos=0 lim=<length> cap=<length>]`, a map as `{key=value}`, and a list as its members in brackets.

## Coral member order

Coral reports members in the order of an internal hash map, not in model order. `src/validation/member-order.ts` lists that order for the input shapes it names and for `PutRecordsRequestEntry`, and aws-kinesis-local checks any other members afterwards in model order. The same table keeps the order of the `ShardIteratorType` values in enum messages and the label that Coral prints for `PutRecordsRequestEntry` list members.

## Rules the model cannot express

| Member | Rule |
| --- | --- |
| `StreamName` | Required when the request has no `StreamARN`, except in `ListShards` and `ListStreams`. The model marks it optional because either member identifies the stream. |
| `ShardCount` in `CreateStream` | Required unless `StreamModeDetails` asks for `ON_DEMAND`. |
| `PartitionKey` | Required unless the target stream uses the `AUTO` record distribution strategy. |
| `Data` | Limited to the `MaxRecordSizeInKiB` of the target stream, which is 1 MiB unless `UpdateMaxRecordSize` changed it. |
