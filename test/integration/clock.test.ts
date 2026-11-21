import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  CreateStreamCommand, DeleteStreamCommand, DescribeStreamSummaryCommand, GetRecordsCommand, GetShardIteratorCommand, ListStreamsCommand,
  PutRecordCommand, RegisterStreamConsumerCommand, SubscribeToShardCommand, type KinesisClient,
} from '@aws-sdk/client-kinesis'
import { start, type KinesisLocal, type StartOptions } from '../../src/index.ts'
import { parseBody, send } from './http.ts'
import { kinesis, rejects, text } from './helpers.ts'

const DELAY_SECONDS = 60
const SHARD = 'shardId-000000000000'

let server: KinesisLocal
let client: KinesisClient

function startServer(options: Partial<StartOptions> = {}) {
  return start({
    port: 0,
    host: '127.0.0.1',
    createStreamMs: DELAY_SECONDS * 1000,
    deleteStreamMs: DELAY_SECONDS * 1000,
    updateStreamMs: DELAY_SECONDS * 1000,
    accountId: '000000000000',
    region: 'eu-west-1',
    logLevel: 'error',
    ...options,
  })
}

beforeEach(async () => {
  server = await startServer()
  client = kinesis(server.endpoint)
})

afterEach(async () => {
  client.destroy()
  await server.close()
})

async function advance(body: unknown) {
  const response = await send(server.endpoint, { path: '/_control/clock', body: typeof body === 'string' ? body : JSON.stringify(body) })
  return { status: response.status, body: parseBody(response) as any }
}

async function advanceSeconds(seconds: number) {
  const response = await advance({ advanceSeconds: seconds })
  assert.equal(response.status, 200)
  return response.body.offsetSeconds as number
}

async function summary(name: string) {
  return (await client.send(new DescribeStreamSummaryCommand({ StreamName: name }))).StreamDescriptionSummary!
}

async function activeStream(name: string) {
  await client.send(new CreateStreamCommand({ StreamName: name, ShardCount: 1 }))
  await advanceSeconds(DELAY_SECONDS)
  const { StreamStatus, StreamARN } = await summary(name)
  assert.equal(StreamStatus, 'ACTIVE')
  return StreamARN!
}

async function iterator(name: string) {
  return (await client.send(new GetShardIteratorCommand({ StreamName: name, ShardId: SHARD, ShardIteratorType: 'TRIM_HORIZON' }))).ShardIterator!
}

function put(name: string, data: string) {
  return client.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.from(data) }))
}

async function records(name: string) {
  return (await client.send(new GetRecordsCommand({ ShardIterator: await iterator(name) }))).Records!
}

describe('clock', () => {
  it('keeps real time until a test moves it', async () => {
    const createdAt = async (name: string) => {
      await client.send(new CreateStreamCommand({ StreamName: name, ShardCount: 1 }))
      return (await summary(name)).StreamCreationTimestamp!.getTime()
    }
    const before = Date.now()
    assert.deepEqual(await advance({ advanceSeconds: 0 }), { status: 200, body: { offsetSeconds: 0 } })
    assert.ok(Math.abs(await createdAt('orders') - before) < 5000)
    assert.equal(await advanceSeconds(3600), 3600)
    assert.ok(Math.abs(await createdAt('payments') - before - 3600 * 1000) < 5000)
  })

  it('expires a shard iterator once the clock passes five minutes', async () => {
    await activeStream('orders')
    await put('orders', 'first')
    const first = await iterator('orders')
    await advanceSeconds(299)
    const { Records } = await client.send(new GetRecordsCommand({ ShardIterator: first }))
    assert.deepEqual(Records!.map(record => text(record.Data)), ['first'])
    await advanceSeconds(2)
    await rejects(client.send(new GetRecordsCommand({ ShardIterator: first })), 'ExpiredIteratorException', /tolerated delay of 300000 milliseconds/)
  })

  it('hides records once the clock passes the retention period', async () => {
    await activeStream('orders')
    await put('orders', 'old')
    await advanceSeconds(23 * 3600)
    await put('orders', 'new')
    assert.deepEqual((await records('orders')).map(record => text(record.Data)), ['old', 'new'])
    await advanceSeconds(3600 + 1)
    assert.deepEqual((await records('orders')).map(record => text(record.Data)), ['new'])
  })

  it('runs a pending transition once the clock passes its due time', async () => {
    await client.send(new CreateStreamCommand({ StreamName: 'orders', ShardCount: 1 }))
    await advanceSeconds(DELAY_SECONDS - 1)
    assert.equal((await summary('orders')).StreamStatus, 'CREATING')
    await advanceSeconds(1)
    assert.equal((await summary('orders')).StreamStatus, 'ACTIVE')
    await client.send(new DeleteStreamCommand({ StreamName: 'orders' }))
    assert.equal((await summary('orders')).StreamStatus, 'DELETING')
    await advanceSeconds(DELAY_SECONDS)
    assert.deepEqual((await client.send(new ListStreamsCommand({}))).StreamNames, [])
  })

  it('keeps sequence numbers in order after the clock moves', async () => {
    await activeStream('orders')
    const first = await put('orders', 'a')
    await advanceSeconds(3600)
    const second = await put('orders', 'b')
    const third = await put('orders', 'c')
    const sequences = [first, second, third].map(result => BigInt(result.SequenceNumber!))
    assert.ok(sequences[0]! < sequences[1]! && sequences[1]! < sequences[2]!)
    const read = await records('orders')
    assert.deepEqual(read.map(record => text(record.Data)), ['a', 'b', 'c'])
    assert.ok(read[1]!.ApproximateArrivalTimestamp!.getTime() - read[0]!.ApproximateArrivalTimestamp!.getTime() >= 3600 * 1000)
  })

  it('ends a SubscribeToShard stream once the clock passes five minutes', async () => {
    const { Consumer } = await client.send(new RegisterStreamConsumerCommand({ StreamARN: await activeStream('orders'), ConsumerName: 'reader' }))
    await advanceSeconds(DELAY_SECONDS)
    const subscribe = async () => {
      const subscription = await client.send(new SubscribeToShardCommand({
        ConsumerARN: Consumer!.ConsumerARN,
        ShardId: SHARD,
        StartingPosition: { Type: 'TRIM_HORIZON' },
      }))
      const events = subscription.EventStream![Symbol.asyncIterator]()
      assert.ok((await events.next()).value?.SubscribeToShardEvent)
      return events
    }
    const events = await subscribe()
    await advanceSeconds(300)
    assert.equal((await events.next()).done, true)
    await (await subscribe()).return?.()
  })

  it('returns to real time after a full reset and not after a reset of one stream', async () => {
    await activeStream('orders')
    await activeStream('payments')
    assert.deepEqual(await server.reset('orders'), ['orders'])
    assert.equal(await advanceSeconds(0), 2 * DELAY_SECONDS)
    assert.deepEqual(await server.reset(), ['payments'])
    assert.equal(await advanceSeconds(0), 0)
  })

  it('rejects a body without a valid advanceSeconds member', async () => {
    for (const body of ['', '60', '[]', '{}', '{"advanceSeconds": "60"}', '{"advanceSeconds": -1}', '{"advanceSeconds": 315360001}']) {
      const response = await advance(body)
      assert.equal(response.status, 400)
      assert.match(response.body.message, /advanceSeconds/)
    }
    assert.equal(await advanceSeconds(0), 0)
  })

  it('offers the same clock through the object that start() returns', async () => {
    assert.equal(await server.advanceClock(60), 60)
    assert.equal(await advanceSeconds(30), 90)
    await assert.rejects(server.advanceClock(-1), RangeError)
    assert.equal(await server.advanceClock(0), 90)
  })

  it('keeps the clock across a restart', async () => {
    const path = mkdtempSync(join(tmpdir(), 'kinesis-clock-'))
    let persistent = await startServer({ path })
    try {
      assert.equal(await persistent.advanceClock(3600), 3600)
      await persistent.close()
      persistent = await startServer({ path })
      assert.equal(await persistent.advanceClock(0), 3600)
    } finally {
      await persistent.close()
    }
  })
})
