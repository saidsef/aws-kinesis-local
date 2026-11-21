import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, it } from 'node:test'
import { stringifySequence } from '../../src/kinesis/sequence.ts'
import { Logger } from '../../src/logger.ts'
import { Store } from '../../src/store/store.ts'
import type { StoredDocument, StoredRecord, StreamDoc } from '../../src/store/types.ts'
import { MapBackend } from '../backends/map.ts'

const CREATED = Date.UTC(2026, 10, 21, 9)

// Each call waits for the next delay in the list before it reaches the Map objects.
class SlowBackend extends MapBackend {
  readonly delays: number[]
  readonly calls: string[] = []

  constructor(delays: number[]) {
    super()
    this.delays = delays
  }

  private async wait(call: string) {
    await sleep(this.delays.shift() ?? 0)
    this.calls.push(call)
  }

  override async putDocument(document: StoredDocument) {
    await this.wait(`putDocument ${document.key}`)
    await super.putDocument(document)
  }

  override async putRecords(stream: StreamDoc, records: StoredRecord[]) {
    await this.wait(`putRecords ${stream.StreamName}`)
    await super.putRecords(stream, records)
  }
}

function store(backend: MapBackend) {
  return new Store({
    createStreamMs: 0,
    deleteStreamMs: 0,
    updateStreamMs: 0,
    expiryIntervalMs: 60000,
    shardLimit: 10,
    accountId: '000000000000',
    region: 'eu-west-1',
  }, new Logger('error', () => {}), backend)
}

function stream(name: string): StreamDoc {
  return {
    RetentionPeriodHours: 24,
    EnhancedMonitoring: [{ ShardLevelMetrics: [] }],
    EncryptionType: 'NONE',
    HasMoreShards: false,
    Shards: [],
    StreamARN: `arn:aws:kinesis:eu-west-1:000000000000:stream/${name}`,
    StreamName: name,
    StreamStatus: 'ACTIVE',
    StreamCreationTimestamp: CREATED / 1000,
    _seqIx: [0],
    _tags: {},
  }
}

function record(counter: number): StoredRecord {
  return {
    shardIx: 0,
    sequenceNumber: stringifySequence({ shardCreateTime: CREATED, shardIx: 0, seqIx: counter, seqTime: CREATED }),
    partitionKey: 'key',
    data: Buffer.from(`record ${counter}`),
    arrival: CREATED / 1000,
    encryptionType: null,
  }
}

function saved(backend: MapBackend, name: string) {
  return backend.documents.get('stream')?.get(name)?.value as StreamDoc | undefined
}

describe('store writes', () => {
  it('keeps the last change to a stream when an earlier write is slower', async () => {
    const backend = new SlowBackend([50, 0])
    const target = store(backend)
    const doc = stream('orders')
    const first = target.saveStream(doc)
    doc.StreamStatus = 'UPDATING'
    const second = target.saveStream(doc)
    await Promise.all([first, second])
    assert.equal(saved(backend, 'orders')?.StreamStatus, 'UPDATING')
    await target.close()
  })

  it('saves each document as it was when the write began', async () => {
    const backend = new SlowBackend([50])
    const target = store(backend)
    const doc = stream('orders')
    const write = target.saveStream(doc)
    doc.StreamStatus = 'DELETING'
    await write
    assert.equal(saved(backend, 'orders')?.StreamStatus, 'ACTIVE')
    await target.close()
  })

  it('reads the records of a write that is still in progress', async () => {
    const backend = new SlowBackend([50])
    const target = store(backend)
    const doc = stream('orders')
    const write = target.putRecords(doc, [record(1), record(2)])
    const read = await target.readRecords({ stream: 'orders', shardIx: 0, limit: 10 })
    assert.deepEqual(read.map(entry => entry.data.toString()), ['record 1', 'record 2'])
    await write
    await target.close()
  })

  it('lets a write to one stream finish before a slower write to another stream', async () => {
    const backend = new SlowBackend([100, 0])
    const target = store(backend)
    await Promise.all([target.putRecords(stream('slow'), [record(1)]), target.putRecords(stream('fast'), [record(1)])])
    assert.deepEqual(backend.calls.filter(entry => entry.startsWith('putRecords')), ['putRecords fast', 'putRecords slow'])
    await target.close()
  })

  it('finishes the writes in progress before it closes', async () => {
    const backend = new SlowBackend([50])
    const target = store(backend)
    void target.saveStream(stream('orders'))
    await target.close()
    assert.equal(saved(backend, 'orders')?.StreamName, 'orders')
    await assert.rejects(target.readRecords({ stream: 'orders', shardIx: 0, limit: 10 }), /closed/)
  })
})
