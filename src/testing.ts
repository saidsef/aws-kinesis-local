import assert from 'node:assert/strict'
import { shardIdName, stringifySequence } from './kinesis/sequence.ts'
import type { ChannelDoc, ConsumerDoc, StorageBackend, StoredDocument, StoredRecord, StreamDoc } from './store/types.ts'

export interface StorageBackendTest {
  name: string
  run(backend: StorageBackend): Promise<void>
}

const CREATED = Date.UTC(2026, 10, 21, 9)
const CREATED_SECONDS = CREATED / 1000
const STREAM_ARN = 'arn:aws:kinesis:eu-west-1:000000000000:stream/orders'
const CONSUMER_ARN = `${STREAM_ARN}/consumer/reader:${CREATED_SECONDS}`
const CHANNEL_ARN = 'arn:aws:kinesis:eu-west-1:000000000000:channel/archive'

function streamDoc(name: string, counter: number | null = null): StreamDoc {
  return {
    RetentionPeriodHours: 24,
    EnhancedMonitoring: [{ ShardLevelMetrics: [] }],
    EncryptionType: 'NONE',
    HasMoreShards: false,
    Shards: [0, 1].map(shardIx => ({
      HashKeyRange: shardIx === 0
        ? { StartingHashKey: '0', EndingHashKey: '170141183460469231731687303715884105727' }
        : { StartingHashKey: '170141183460469231731687303715884105728', EndingHashKey: '340282366920938463463374607431768211455' },
      SequenceNumberRange: { StartingSequenceNumber: stringifySequence({ shardCreateTime: CREATED, shardIx }) },
      ShardId: shardIdName(shardIx),
    })),
    StreamARN: `arn:aws:kinesis:eu-west-1:000000000000:stream/${name}`,
    StreamName: name,
    StreamStatus: 'ACTIVE',
    StreamCreationTimestamp: CREATED_SECONDS,
    StreamModeDetails: { StreamMode: 'PROVISIONED' },
    _seqIx: [counter],
    _tags: { team: 'data' },
  }
}

function consumerDoc(): ConsumerDoc {
  return {
    ConsumerName: 'reader',
    ConsumerARN: CONSUMER_ARN,
    ConsumerStatus: 'CREATING',
    ConsumerCreationTimestamp: CREATED_SECONDS,
    StreamARN: STREAM_ARN,
    StreamName: 'orders',
    _tags: {},
    _pending: { action: 'activateConsumer', due: CREATED + 500 },
  }
}

function channelDoc(): ChannelDoc {
  return {
    ChannelName: 'archive',
    ChannelARN: CHANNEL_ARN,
    ChannelId: '6f1c4a1e-3c2b-4f0e-9a51-0d2f6b7c8e90',
    ChannelStatus: 'ACTIVE',
    ChannelCreationTimestamp: CREATED_SECONDS,
    ServiceExecutionRoleARN: 'arn:aws:iam::000000000000:role/channel',
    StreamConfigurationList: [{ StreamARN: STREAM_ARN, RecordConfiguration: { RecordFormatType: 'JSON' } }],
    S3DestinationConfiguration: { DataFreshnessInSeconds: 300, StorageConfiguration: { BucketARN: 'arn:aws:s3:::archive', CompressionType: 'GZIP' } },
    LoggingConfiguration: { CloudWatchLogs: { Enabled: false } },
    _tags: {},
    _activatedAt: CREATED + 1000,
  }
}

function record(shardIx: number, counter: number, seconds: number, data: string | Buffer = `record ${counter}`): StoredRecord {
  return {
    shardIx,
    sequenceNumber: stringifySequence({ shardCreateTime: CREATED, shardIx, seqIx: counter, seqTime: CREATED + seconds * 1000 }),
    partitionKey: `key ${counter}`,
    data: Buffer.from(data),
    arrival: CREATED_SECONDS + seconds + 0.25,
    encryptionType: null,
  }
}

function plain(stored: StoredRecord) {
  return { ...stored, data: Buffer.from(stored.data).toString('hex') }
}

function sorted(documents: StoredDocument[]) {
  return [...documents].sort((a, b) => `${a.kind} ${a.key}` < `${b.kind} ${b.key}` ? -1 : 1)
}

async function stored(backend: StorageBackend, stream: string, shardIx: number) {
  return (await backend.readRecords({ stream, shardIx, limit: 100 })).map(plain)
}

export const storageBackendTests: StorageBackendTest[] = [
  {
    name: 'starts without documents',
    async run(backend) {
      assert.deepEqual(await backend.readDocuments(), [])
    },
  },
  {
    name: 'returns each document that it saves, by kind and key',
    async run(backend) {
      const documents: StoredDocument[] = [
        { kind: 'stream', key: 'orders', value: streamDoc('orders') },
        { kind: 'consumer', key: CONSUMER_ARN, value: consumerDoc() },
        { kind: 'channel', key: CHANNEL_ARN, value: channelDoc() },
        { kind: 'policy', key: STREAM_ARN, value: '{"Version":"2012-10-17","Statement":[]}' },
        { kind: 'policy', key: 'orders', value: '{}' },
        { kind: 'settings', key: 'account', value: { MinimumThroughputBillingCommitment: { Status: 'ENABLED', StartedAt: CREATED_SECONDS } } },
        { kind: 'clock', key: 'offset', value: 86400000 },
      ]
      for (const document of documents) await backend.putDocument(document)
      assert.deepEqual(sorted(await backend.readDocuments()), sorted(documents))
    },
  },
  {
    name: 'replaces a document that it saves again under the same kind and key',
    async run(backend) {
      await backend.putDocument({ kind: 'stream', key: 'orders', value: streamDoc('orders') })
      const updated = { ...streamDoc('orders'), StreamStatus: 'UPDATING' as const, _pending: { action: 'splitShard', due: CREATED + 500, data: { shardIx: 0 } } }
      await backend.putDocument({ kind: 'stream', key: 'orders', value: updated })
      await backend.putDocument({ kind: 'clock', key: 'offset', value: 1000 })
      await backend.putDocument({ kind: 'clock', key: 'offset', value: 2000 })
      assert.deepEqual(sorted(await backend.readDocuments()), [
        { kind: 'clock', key: 'offset', value: 2000 },
        { kind: 'stream', key: 'orders', value: updated },
      ])
    },
  },
  {
    name: 'deletes a document and ignores a document that does not exist',
    async run(backend) {
      await backend.putDocument({ kind: 'stream', key: 'orders', value: streamDoc('orders') })
      await backend.putDocument({ kind: 'policy', key: 'orders', value: '{}' })
      await backend.putDocument({ kind: 'clock', key: 'offset', value: 1000 })
      await backend.deleteDocument('stream', 'orders')
      await backend.deleteDocument('clock', 'offset')
      await backend.deleteDocument('stream', 'missing')
      await backend.deleteDocument('settings', 'account')
      assert.deepEqual(await backend.readDocuments(), [{ kind: 'policy', key: 'orders', value: '{}' }])
    },
  },
  {
    name: 'saves the stream document with the records of each putRecords call',
    async run(backend) {
      const stream = streamDoc('orders', 3)
      await backend.putRecords(stream, [record(0, 1, 0), record(1, 2, 0)])
      assert.deepEqual(await backend.readDocuments(), [{ kind: 'stream', key: 'orders', value: stream }])
      assert.deepEqual(await stored(backend, 'orders', 0), [plain(record(0, 1, 0))])
      assert.deepEqual(await stored(backend, 'orders', 1), [plain(record(1, 2, 0))])
    },
  },
  {
    name: 'returns the records of one shard of one stream in sequence number order',
    async run(backend) {
      await backend.putRecords(streamDoc('orders', 5), [record(0, 3, 2), record(1, 4, 2)])
      await backend.putRecords(streamDoc('orders', 5), [record(0, 1, 0), record(0, 2, 1)])
      await backend.putRecords(streamDoc('payments', 6), [record(0, 5, 0)])
      assert.deepEqual(await stored(backend, 'orders', 0), [record(0, 1, 0), record(0, 2, 1), record(0, 3, 2)].map(plain))
      assert.deepEqual(await stored(backend, 'orders', 1), [plain(record(1, 4, 2))])
      assert.deepEqual(await stored(backend, 'payments', 0), [plain(record(0, 5, 0))])
      assert.deepEqual(await stored(backend, 'missing', 0), [])
    },
  },
  {
    name: 'starts a read at or after a sequence number',
    async run(backend) {
      const records = [record(0, 1, 0), record(0, 2, 1), record(0, 3, 2), record(0, 4, 3)]
      await backend.putRecords(streamDoc('orders', 5), records)
      const read = async (query: { from?: string, after?: string }) =>
        (await backend.readRecords({ stream: 'orders', shardIx: 0, limit: 100, ...query })).map(plain)
      assert.deepEqual(await read({ from: records[1]!.sequenceNumber }), records.slice(1).map(plain))
      assert.deepEqual(await read({ after: records[1]!.sequenceNumber }), records.slice(2).map(plain))
      assert.deepEqual(await read({ after: records[3]!.sequenceNumber }), [])
      assert.deepEqual(await read({ from: streamDoc('orders').Shards[0]!.SequenceNumberRange.StartingSequenceNumber }), records.map(plain))
    },
  },
  {
    name: 'skips the records that arrived before a time',
    async run(backend) {
      const records = [record(0, 1, 0), record(0, 2, 1), record(0, 3, 2)]
      await backend.putRecords(streamDoc('orders', 4), records)
      const read = async (query: { after?: string, arrivedSince: number }) =>
        (await backend.readRecords({ stream: 'orders', shardIx: 0, limit: 100, ...query })).map(plain)
      assert.deepEqual(await read({ arrivedSince: records[1]!.arrival }), records.slice(1).map(plain))
      assert.deepEqual(await read({ arrivedSince: records[1]!.arrival + 0.5 }), records.slice(2).map(plain))
      assert.deepEqual(await read({ after: records[0]!.sequenceNumber, arrivedSince: records[0]!.arrival }), records.slice(1).map(plain))
      assert.deepEqual(await read({ arrivedSince: records[2]!.arrival + 1 }), [])
    },
  },
  {
    name: 'returns no more records than the limit',
    async run(backend) {
      const records = [1, 2, 3, 4, 5].map(counter => record(0, counter, counter))
      await backend.putRecords(streamDoc('orders', 6), records)
      assert.deepEqual((await backend.readRecords({ stream: 'orders', shardIx: 0, limit: 2 })).map(plain), records.slice(0, 2).map(plain))
      const page = await backend.readRecords({ stream: 'orders', shardIx: 0, after: records[1]!.sequenceNumber, limit: 2 })
      assert.deepEqual(page.map(plain), records.slice(2, 4).map(plain))
    },
  },
  {
    name: 'returns the data, partition key, arrival time and encryption type of each record',
    async run(backend) {
      const binary = { ...record(0, 1, 0, Buffer.from([0, 1, 127, 128, 254, 255])), partitionKey: null, encryptionType: 'KMS' }
      const empty = { ...record(0, 2, 1, Buffer.alloc(0)), arrival: CREATED_SECONDS + 1.001 }
      await backend.putRecords(streamDoc('orders', 3), [binary, empty])
      const [first, second] = await backend.readRecords({ stream: 'orders', shardIx: 0, limit: 100 })
      assert.ok(first?.data instanceof Uint8Array && second?.data instanceof Uint8Array)
      assert.deepEqual(plain(first), plain(binary))
      assert.deepEqual(plain(second), plain(empty))
    },
  },
  {
    name: 'expires the oldest records of one shard that arrived before a time',
    async run(backend) {
      const records = [record(0, 1, 0), record(0, 2, 1), record(0, 3, 2), record(0, 4, 3)]
      await backend.putRecords(streamDoc('orders', 6), [...records, record(1, 5, 0)])
      await backend.putRecords(streamDoc('payments', 7), [record(0, 6, 0)])
      assert.equal(await backend.expireRecords('orders', 0, CREATED_SECONDS + 2, 10), 2)
      assert.deepEqual(await stored(backend, 'orders', 0), records.slice(2).map(plain))
      assert.equal(await backend.expireRecords('orders', 0, CREATED_SECONDS + 10, 1), 1)
      assert.deepEqual(await stored(backend, 'orders', 0), records.slice(3).map(plain))
      assert.equal(await backend.expireRecords('orders', 0, CREATED_SECONDS, 10), 0)
      assert.equal(await backend.expireRecords('missing', 0, CREATED_SECONDS + 10, 10), 0)
      assert.deepEqual(await stored(backend, 'orders', 1), [plain(record(1, 5, 0))])
      assert.deepEqual(await stored(backend, 'payments', 0), [plain(record(0, 6, 0))])
    },
  },
  {
    name: 'deletes every record of one stream and keeps its document',
    async run(backend) {
      await backend.putRecords(streamDoc('orders', 3), [record(0, 1, 0), record(1, 2, 0)])
      await backend.putRecords(streamDoc('payments', 4), [record(0, 3, 0)])
      await backend.deleteRecords('orders')
      await backend.deleteRecords('missing')
      assert.deepEqual(await stored(backend, 'orders', 0), [])
      assert.deepEqual(await stored(backend, 'orders', 1), [])
      assert.deepEqual(await stored(backend, 'payments', 0), [plain(record(0, 3, 0))])
      assert.deepEqual((await backend.readDocuments()).map(document => document.key).sort(), ['orders', 'payments'])
    },
  },
  {
    name: 'saves the delivery positions of each channel, stream and shard',
    async run(backend) {
      const [first, second, third] = [record(0, 1, 0), record(1, 2, 0), record(1, 3, 1)].map(entry => entry.sequenceNumber)
      await backend.putDeliveryPositions('channel-1', 'orders', new Map([[0, first!], [1, second!]]))
      await backend.putDeliveryPositions('channel-1', 'orders', new Map([[1, third!]]))
      await backend.putDeliveryPositions('channel-1', 'payments', new Map([[0, second!]]))
      await backend.putDeliveryPositions('channel-2', 'orders', new Map([[0, third!]]))
      assert.deepEqual(await backend.readDeliveryPositions('channel-1', 'orders'), new Map([[0, first], [1, third]]))
      assert.deepEqual(await backend.readDeliveryPositions('channel-1', 'payments'), new Map([[0, second]]))
      assert.deepEqual(await backend.readDeliveryPositions('channel-2', 'orders'), new Map([[0, third]]))
      assert.deepEqual(await backend.readDeliveryPositions('channel-3', 'orders'), new Map())
    },
  },
  {
    name: 'deletes the delivery positions of one channel',
    async run(backend) {
      const position = record(0, 1, 0).sequenceNumber
      await backend.putDeliveryPositions('channel-1', 'orders', new Map([[0, position]]))
      await backend.putDeliveryPositions('channel-1', 'payments', new Map([[0, position]]))
      await backend.putDeliveryPositions('channel-2', 'orders', new Map([[0, position]]))
      await backend.deleteDeliveryPositions('channel-1')
      await backend.deleteDeliveryPositions('channel-3')
      assert.deepEqual(await backend.readDeliveryPositions('channel-1', 'orders'), new Map())
      assert.deepEqual(await backend.readDeliveryPositions('channel-1', 'payments'), new Map())
      assert.deepEqual(await backend.readDeliveryPositions('channel-2', 'orders'), new Map([[0, position]]))
    },
  },
  {
    name: 'answers a ping',
    async run(backend) {
      await backend.ping()
    },
  },
]
