import assert from 'node:assert/strict'
import { request } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, it } from 'node:test'
import {
  CreateStreamCommand, DescribeStreamConsumerCommand, DescribeStreamSummaryCommand, GetRecordsCommand, GetShardIteratorCommand,
  ListStreamConsumersCommand, PutRecordCommand, RegisterStreamConsumerCommand,
} from '@aws-sdk/client-kinesis'
import type { RecordQuery, StoredRecord, StreamDoc } from '../../src/index.ts'
import { MapBackend } from '../backends/map.ts'
import { AMZ_JSON, AUTH, call, send } from './http.ts'
import { kinesis, startTarget, text, waitFor } from './helpers.ts'

const SHARD = 'shardId-000000000000'

async function withServer<T>(backend: MapBackend, work: (client: ReturnType<typeof kinesis>, endpoint: string) => Promise<T>) {
  const target = await startTarget({ backend })
  const client = kinesis(target.endpoint)
  try {
    return await work(client, target.endpoint)
  } finally {
    client.destroy()
    await target.close()
  }
}

async function createActive(client: ReturnType<typeof kinesis>, name: string) {
  await client.send(new CreateStreamCommand({ StreamName: name, ShardCount: 1 }))
  const summary = await waitFor(
    () => client.send(new DescribeStreamSummaryCommand({ StreamName: name })),
    result => result.StreamDescriptionSummary?.StreamStatus === 'ACTIVE',
  )
  return summary.StreamDescriptionSummary!.StreamARN!
}

async function records(client: ReturnType<typeof kinesis>, name: string) {
  const { ShardIterator } = await client.send(new GetShardIteratorCommand({ StreamName: name, ShardId: SHARD, ShardIteratorType: 'TRIM_HORIZON' }))
  return (await client.send(new GetRecordsCommand({ ShardIterator }))).Records!
}

function put(client: ReturnType<typeof kinesis>, name: string, value: string) {
  return client.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.from(value) }))
}

// The first write of records takes the longest and the last the shortest, so writes that ran side by side would finish in reverse.
class SlowerFirst extends MapBackend {
  delayMs = 0

  override async putRecords(stream: StreamDoc, records: StoredRecord[]) {
    const delay = this.delayMs
    this.delayMs = Math.max(0, delay - 5)
    await sleep(delay)
    await super.putRecords(stream, records)
  }
}

class Failing extends MapBackend {
  failing = false

  override async putRecords(stream: StreamDoc, records: StoredRecord[]) {
    if (this.failing) throw new Error('The datastore is unavailable.')
    await super.putRecords(stream, records)
  }

  override async ping() {
    if (this.failing) throw new Error('The datastore is unavailable.')
  }
}

class SlowTimestampReads extends MapBackend {
  reads = 0

  override async readRecords(query: RecordQuery) {
    this.reads++
    if (query.arrivedSince !== undefined) await sleep(300)
    return super.readRecords(query)
  }
}

describe('storage backend from the caller', () => {
  it('keeps streams, records and consumers in the backend across restarts', async () => {
    const backend = new MapBackend()
    const arn = await withServer(backend, async client => {
      const streamArn = await createActive(client, 'kept')
      await put(client, 'kept', 'first')
      await client.send(new RegisterStreamConsumerCommand({ StreamARN: streamArn, ConsumerName: 'reader' }))
      return streamArn
    })
    assert.deepEqual([...backend.documents.get('stream')!.keys()], ['kept'])
    await withServer(backend, async client => {
      const first = await records(client, 'kept')
      assert.deepEqual(first.map(record => text(record.Data)), ['first'])
      const consumers = await waitFor(() => client.send(new ListStreamConsumersCommand({ StreamARN: arn })), result => result.Consumers?.[0]?.ConsumerStatus === 'ACTIVE')
      assert.equal(consumers.Consumers?.[0]?.ConsumerName, 'reader')
      const next = await put(client, 'kept', 'second')
      assert.ok(BigInt(next.SequenceNumber!) > BigInt(first[0]!.SequenceNumber!))
    })
  })

  it('runs the requests to one stream in the order they arrive', async () => {
    const backend = new SlowerFirst()
    const count = 20
    const sequences = await withServer(backend, async client => {
      await createActive(client, 'ordered')
      backend.delayMs = count * 5
      const results = await Promise.all(Array.from({ length: count }, (_, i) => put(client, 'ordered', `record ${i}`)))
      return results.map(result => result.SequenceNumber!)
    })
    assert.equal(new Set(sequences).size, count)
    await withServer(backend, async client => {
      const last = await put(client, 'ordered', 'after restart')
      const read = await records(client, 'ordered')
      assert.equal(read.length, count + 1)
      assert.equal(read.at(-1)!.SequenceNumber, last.SequenceNumber)
      assert.equal(text(read.at(-1)!.Data), 'after restart')
    })
  })

  it('answers InternalFailure and fails its health check while the backend fails', async () => {
    const backend = new Failing()
    await withServer(backend, async (client, endpoint) => {
      await createActive(client, 'failing')
      backend.failing = true
      const response = await call(endpoint, 'PutRecord', { StreamName: 'failing', PartitionKey: 'p', Data: Buffer.from('lost').toString('base64') })
      assert.equal(response.status, 500)
      assert.match(response.body.toString(), /InternalFailure/)
      assert.equal((await send(endpoint, { method: 'GET', path: '/healthz' })).status, 503)
      backend.failing = false
      assert.equal((await send(endpoint, { method: 'GET', path: '/healthz' })).status, 200)
      await put(client, 'failing', 'kept')
      assert.deepEqual((await records(client, 'failing')).map(record => text(record.Data)), ['kept'])
    })
  })

  it('stops a subscription whose client leaves while the backend reads its starting position', async () => {
    const backend = new SlowTimestampReads()
    await withServer(backend, async (client, endpoint) => {
      const { Consumer } = await client.send(new RegisterStreamConsumerCommand({ StreamARN: await createActive(client, 'left'), ConsumerName: 'reader' }))
      await waitFor(() => client.send(new DescribeStreamConsumerCommand({ ConsumerARN: Consumer!.ConsumerARN })), result => result.ConsumerDescription?.ConsumerStatus === 'ACTIVE')
      const body = JSON.stringify({ ConsumerARN: Consumer!.ConsumerARN, ShardId: SHARD, StartingPosition: { Type: 'AT_TIMESTAMP', Timestamp: Date.now() / 1000 - 60 } })
      const req = request(new URL('/', endpoint), { method: 'POST', headers: { 'content-type': AMZ_JSON, 'x-amz-target': 'Kinesis_20131202.SubscribeToShard', ...AUTH } })
      req.on('error', () => {})
      req.end(body)
      await sleep(100)
      req.destroy()
      const reads = backend.reads
      await sleep(1500)
      assert.equal(backend.reads, reads)
    })
  })

  it('refuses a path together with a backend', async () => {
    await assert.rejects(startTarget({ backend: new MapBackend(), path: 'data' }), /path option belongs to the SQLite backend/)
  })
})
