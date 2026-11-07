import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KinesisError } from '../../src/errors.ts'
import { coerceStructure, decodeBlobs, validateStructure, type ValidationContext } from '../../src/validation/validate.ts'

const context: ValidationContext = { partitionKeyRequired: true, maxRecordBytes: 1048576 }

function failure(shape: string, data: Record<string, unknown>, options = context) {
  try {
    validateStructure(coerceStructure(data, shape), shape, options)
  } catch (error) {
    assert.ok(error instanceof KinesisError)
    return error.body
  }
  return null
}

function typeFailure(shape: string, data: Record<string, unknown>) {
  try {
    coerceStructure(data, shape)
  } catch (error) {
    assert.ok(error instanceof KinesisError)
    return error.body
  }
  return null
}

describe('type checks', () => {
  it('reports the Coral messages for mismatched JSON types', () => {
    assert.deepEqual(typeFailure('CreateStreamInput', { ShardCount: 'two' }), { __type: 'SerializationException', Message: 'class java.lang.String can not be converted to an Integer' })
    assert.deepEqual(typeFailure('CreateStreamInput', { StreamName: true }), { __type: 'SerializationException', Message: 'class java.lang.Boolean can not be converted to an String' })
    assert.deepEqual(typeFailure('AddTagsToStreamInput', { Tags: [] }), { __type: 'SerializationException', Message: 'Start of list found where not expected' })
    assert.deepEqual(typeFailure('PutRecordInput', { Data: 'abc' }), {
      __type: 'SerializationException',
      Message: '\'abc\' can not be converted to a Blob: Base64 encoded length is expected a multiple of 4 bytes but found: 3',
    })
    assert.deepEqual(typeFailure('GetShardIteratorInput', { Timestamp: 'now' }), {
      __type: 'SerializationException',
      Message: 'class java.lang.String can not be converted to milliseconds since epoch',
    })
  })

  it('drops unknown members and nulls, and truncates integers', () => {
    assert.deepEqual(coerceStructure({ StreamName: 's', ShardCount: 2.9, Unknown: 1, Tags: null }, 'CreateStreamInput'), { StreamName: 's', ShardCount: 2 })
  })

  it('accepts CBOR byte strings and tagged dates', () => {
    const data = coerceStructure({ StreamName: 's', ShardId: '0', ShardIteratorType: 'AT_TIMESTAMP', Timestamp: new Date(1794063723456) }, 'GetShardIteratorInput')
    assert.equal(data.Timestamp, 1794063723.456)
    assert.deepEqual(coerceStructure({ Data: Buffer.from('x') }, 'PutRecordInput').Data, Buffer.from('x'))
  })
})

describe('constraint checks', () => {
  it('lists errors in the order that Coral reports them', () => {
    assert.deepEqual(failure('CreateStreamInput', {}), {
      __type: 'ValidationException',
      message: '2 validation errors detected: Value null at \'shardCount\' failed to satisfy constraint: Member must not be null; ' +
        'Value null at \'streamName\' failed to satisfy constraint: Member must not be null',
    })
  })

  it('accepts a stream ARN in place of a stream name', () => {
    assert.equal(failure('DescribeStreamInput', { StreamARN: 'arn:aws:kinesis:eu-west-1:000000000000:stream/s' }), null)
    assert.match(failure('DescribeStreamInput', { StreamARN: 'stream/s' })!.message!, /at 'streamARN' failed to satisfy constraint: Member must satisfy regular expression pattern/)
  })

  it('shows patterns, enums and nested paths like Coral', () => {
    assert.equal(failure('GetShardIteratorInput', { StreamName: 's', ShardId: '0', ShardIteratorType: 'X' })!.message,
      '1 validation error detected: Value \'X\' at \'shardIteratorType\' failed to satisfy constraint: Member must satisfy enum value set: ' +
      '[AFTER_SEQUENCE_NUMBER, LATEST, AT_TIMESTAMP, AT_SEQUENCE_NUMBER, TRIM_HORIZON]')
    assert.equal(failure('SplitShardInput', { StreamName: 's', ShardToSplit: '0', NewStartingHashKey: 'a' })!.message,
      '1 validation error detected: Value \'a\' at \'newStartingHashKey\' failed to satisfy constraint: Member must satisfy regular expression pattern: 0|([1-9]\\d{0,38})')
    assert.match(failure('PutRecordsInput', { StreamName: 's', Records: [{}] })!.message!,
      /^2 validation errors detected: Value null at 'records.1.member.partitionKey' failed to satisfy constraint: Member must not be null; Value null at 'records.1.member.data'/)
  })

  it('describes blobs, lists and maps the way Coral prints them', () => {
    assert.match(failure('PutRecordInput', { StreamName: 's', PartitionKey: 'p', Data: Buffer.alloc(1048577) })!.message!,
      /Value 'java.nio.HeapByteBuffer\[pos=0 lim=1048577 cap=1048577\]' at 'data'/)
    assert.match(failure('AddTagsToStreamInput', { StreamName: 's', Tags: { ['k'.repeat(129)]: 'v' } })!.message!,
      /Map keys must satisfy constraint: \[Member must have length less than or equal to 128, Member must have length greater than or equal to 1\]/)
    assert.match(failure('PutRecordsInput', { StreamName: 's', Records: [] })!.message!, /Value '\[\]' at 'records'/)
  })

  it('stops after ten errors', () => {
    const records = Array.from({ length: 12 }, () => ({}))
    assert.match(failure('PutRecordsInput', { StreamName: 's', Records: records })!.message!, /^10 validation errors detected/)
  })

  it('applies the record size and partition key rules of the target stream', () => {
    assert.equal(failure('PutRecordInput', { StreamName: 's', PartitionKey: 'p', Data: Buffer.alloc(2000000) }, { partitionKeyRequired: true, maxRecordBytes: 10485760 }), null)
    assert.equal(failure('PutRecordInput', { StreamName: 's', Data: Buffer.alloc(1) }, { partitionKeyRequired: false, maxRecordBytes: 1048576 }), null)
  })

  it('checks list members of new operations against the model', () => {
    assert.match(failure('EnableEnhancedMonitoringInput', { StreamName: 's', ShardLevelMetrics: ['Nope'] })!.message!,
      /Member must satisfy constraint: \[Member must satisfy enum value set: \[IncomingBytes,/)
    assert.match(failure('UpdateMaxRecordSizeInput', { StreamARN: 'arn:aws:kinesis:eu-west-1:000000000000:stream/s', MaxRecordSizeInKiB: 10 })!.message!,
      /Member must have value greater than or equal to 1024/)
  })
})

describe('blob decoding', () => {
  it('turns base64 members into buffers', () => {
    const data = decodeBlobs({ StreamName: 's', Records: [{ PartitionKey: 'p', Data: 'aGk=' }] }, 'PutRecordsInput') as { Records: { Data: Buffer }[] }
    assert.deepEqual(data.Records[0]!.Data, Buffer.from('hi'))
  })
})
