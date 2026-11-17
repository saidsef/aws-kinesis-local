import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatError, nextBatch } from '../../src/delivery/channel.ts'
import { shardIdName, stringifySequence } from '../../src/kinesis/sequence.ts'
import { Logger } from '../../src/logger.ts'
import { Store } from '../../src/store/store.ts'
import type { ChannelDoc, ShardDoc, StreamDoc } from '../../src/store/types.ts'

const CREATED = Date.UTC(2026, 10, 17, 9)
const ACTIVATED = CREATED + 60000

function store() {
  return new Store({
    createStreamMs: 0,
    deleteStreamMs: 0,
    updateStreamMs: 0,
    expiryIntervalMs: 60000,
    shardLimit: 10,
    accountId: '000000000000',
    region: 'eu-west-1',
  }, new Logger('error', () => {}))
}

function shard(shardIx: number, createTime: number, parent?: string): ShardDoc {
  const doc: ShardDoc = {
    HashKeyRange: { StartingHashKey: '0', EndingHashKey: '1' },
    SequenceNumberRange: { StartingSequenceNumber: stringifySequence({ shardCreateTime: createTime, shardIx }) },
    ShardId: shardIdName(shardIx),
  }
  if (parent) doc.ParentShardId = parent
  return doc
}

// Shard 0 closes in a split into shards 1 and 2, and every record holds one byte.
function splitStream(target: Store) {
  const splitAt = ACTIVATED + 60000
  const parent = shard(0, CREATED)
  parent.SequenceNumberRange.EndingSequenceNumber = stringifySequence({ shardCreateTime: CREATED, shardIx: 0, seqIx: 0x7fffffffffffffffn, seqTime: splitAt })
  const stream: StreamDoc = {
    RetentionPeriodHours: 24,
    EnhancedMonitoring: [{ ShardLevelMetrics: [] }],
    EncryptionType: 'NONE',
    HasMoreShards: false,
    Shards: [parent, shard(1, splitAt + 1000, parent.ShardId), shard(2, splitAt + 1000, parent.ShardId)],
    StreamARN: 'arn:aws:kinesis:eu-west-1:000000000000:stream/split',
    StreamName: 'split',
    StreamStatus: 'ACTIVE',
    StreamCreationTimestamp: CREATED / 1000,
    _seqIx: [null],
    _tags: {},
  }
  target.saveStream(stream)
  let seqIx = 0
  const record = (shardIx: number, data: string, arrival: number) => {
    const createTime = shardIx ? splitAt + 1000 : CREATED
    target.insertRecords('split', [{
      shardIx,
      sequenceNumber: stringifySequence({ shardCreateTime: createTime, shardIx, seqIx: ++seqIx, seqTime: arrival }),
      partitionKey: 'key',
      data: Buffer.from(data),
      arrival: arrival / 1000,
      encryptionType: null,
    }])
  }
  record(0, 'o', CREATED + 1000)
  record(0, 'a', ACTIVATED + 1000)
  record(0, 'b', ACTIVATED + 2000)
  record(0, 'c', ACTIVATED + 3000)
  record(1, 'd', splitAt + 2000)
  record(2, 'e', splitAt + 2000)
  return stream
}

function channel(target: Store): ChannelDoc {
  const doc: ChannelDoc = {
    ChannelName: 'split-channel',
    ChannelARN: 'arn:aws:kinesis:eu-west-1:000000000000:channel/split-channel',
    ChannelId: 'channel-id',
    ChannelStatus: 'ACTIVE',
    ChannelCreationTimestamp: CREATED / 1000,
    ServiceExecutionRoleARN: 'arn:aws:iam::000000000000:role/channel',
    StreamConfigurationList: [],
    LoggingConfiguration: { CloudWatchLogs: { Enabled: false } },
    _tags: {},
    _activatedAt: ACTIVATED,
  }
  target.saveChannel(doc)
  return doc
}

function data(records: { Data: Buffer }[]) {
  return records.map(record => record.Data.toString('utf8')).join('')
}

describe('record format checks', () => {
  it('accepts JSON and UTF-8 text, and any bytes for BYTE_ARRAY', () => {
    for (const json of ['{"id":1}', '[1,2]', '"text"', '42', 'null']) assert.equal(formatError(Buffer.from(json), 'JSON'), undefined, json)
    assert.equal(formatError(Buffer.from('caf\u00e9 \u2603'), 'STRING'), undefined)
    assert.equal(formatError(Buffer.from([0xff, 0x00, 0xfe]), 'BYTE_ARRAY'), undefined)
  })

  it('names the reason a JSON or STRING record fails', () => {
    for (const text of ['not json', '{"id":', '']) assert.match(formatError(Buffer.from(text), 'JSON')!, /^The record is not valid JSON: /, text)
    assert.equal(formatError(Buffer.from([0xff, 0xfe]), 'STRING'), 'The record is not valid UTF-8 text.')
    assert.equal(formatError(Buffer.from([0x7b, 0xc3]), 'JSON'), 'The record is not valid UTF-8 text.')
  })
})

describe('channel delivery batches', () => {
  it('skips the records that arrived before the channel became active', () => {
    const target = store()
    const batch = nextBatch(target, channel(target), splitStream(target))
    assert.equal(data(batch.records), 'abcde')
    assert.equal(batch.full, false)
    target.close()
  })

  it('reads the child shards only once the batches hold every record of the parent shard', () => {
    const target = store()
    const stream = splitStream(target)
    const doc = channel(target)
    const first = nextBatch(target, doc, stream, 2)
    assert.equal(data(first.records), 'ab')
    assert.equal(first.full, true)
    assert.deepEqual([...first.positions.keys()], [0])
    target.saveDeliveryPositions(doc.ChannelId, stream.StreamName, first.positions)
    const second = nextBatch(target, doc, stream)
    assert.equal(data(second.records), 'cde')
    target.saveDeliveryPositions(doc.ChannelId, stream.StreamName, second.positions)
    assert.equal(nextBatch(target, doc, stream).records.length, 0)
    target.close()
  })

  it('forgets the positions of a channel that the store removes', () => {
    const target = store()
    const stream = splitStream(target)
    const doc = channel(target)
    target.saveDeliveryPositions(doc.ChannelId, stream.StreamName, nextBatch(target, doc, stream).positions)
    assert.equal(target.deliveryPositions(doc.ChannelId, stream.StreamName).size, 3)
    target.removeChannel(doc.ChannelARN)
    assert.equal(target.deliveryPositions(doc.ChannelId, stream.StreamName).size, 0)
    target.close()
  })
})
