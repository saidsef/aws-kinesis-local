import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, it, mock } from 'node:test'
import {
  CreateStreamCommand, DecreaseStreamRetentionPeriodCommand, DeleteStreamCommand, DescribeStreamCommand, DescribeStreamSummaryCommand,
  GetRecordsCommand, GetShardIteratorCommand, IncreaseStreamRetentionPeriodCommand, ListStreamConsumersCommand, ListTagsForStreamCommand,
  PutRecordCommand, PutRecordsCommand, RegisterStreamConsumerCommand,
} from '@aws-sdk/client-kinesis'
import { parseSequence, stringifySequence } from '../../src/kinesis/sequence.ts'
import type { StartOptions } from '../../src/index.ts'
import { DATABASE_FILE, SqliteBackend } from '../../src/store/sqlite.ts'
import { call } from './http.ts'
import { kinesis, startTarget, text, waitFor } from './helpers.ts'

const HOUR_MS = 60 * 60 * 1000

function directory() {
  return mkdtempSync(join(tmpdir(), 'kinesis-data-'))
}

async function withServer<T>(path: string, work: (client: ReturnType<typeof kinesis>) => Promise<T>, options: Partial<StartOptions> = {}) {
  const target = await startTarget({ path, ...options })
  const client = kinesis(target.endpoint)
  try {
    return await work(client)
  } finally {
    client.destroy()
    await target.close()
  }
}

function rewindClock(ms: number) {
  const now = Date.now
  return mock.method(Date, 'now', () => now() - ms)
}

function recordCount(path: string) {
  const db = new DatabaseSync(join(path, DATABASE_FILE), { readOnly: true })
  try {
    return (db.prepare('SELECT count(*) AS count FROM records').get() as { count: number }).count
  } finally {
    db.close()
  }
}

function insertBacklog(path: string, stream: string, first: string, count: number) {
  const parts = parseSequence(first)
  const db = new DatabaseSync(join(path, DATABASE_FILE))
  const insert = db.prepare('INSERT INTO records (stream, shard, seq, partition_key, data, arrival, encryption) VALUES (?, 0, ?, ?, ?, ?, NULL)')
  db.exec('BEGIN')
  for (let i = 1; i <= count; i++) {
    insert.run(stream, stringifySequence({ ...parts, seqIx: BigInt(parts.seqIx as string) + BigInt(i) }), 'p', Buffer.from('x'), parts.seqTime / 1000)
  }
  db.exec('COMMIT')
  db.close()
}

function sizeOnDisk(path: string) {
  const file = join(path, DATABASE_FILE)
  return [file, `${file}-wal`].reduce((total, name) => total + (existsSync(name) ? statSync(name).size : 0), 0)
}

function autoVacuum(path: string) {
  const db = new DatabaseSync(join(path, DATABASE_FILE), { readOnly: true })
  try {
    return (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum
  } finally {
    db.close()
  }
}

async function putMegabytes(client: ReturnType<typeof kinesis>, name: string, megabytes: number) {
  const Data = Buffer.alloc(10 * 1024, 'x')
  for (let i = 0; i < megabytes / 2.5; i++) {
    const Records = Array.from({ length: 250 }, (_, j) => ({ PartitionKey: `p${j}`, Data }))
    const { FailedRecordCount } = await client.send(new PutRecordsCommand({ StreamName: name, Records }))
    assert.equal(FailedRecordCount, 0)
  }
}

async function createActive(client: ReturnType<typeof kinesis>, name: string) {
  await client.send(new CreateStreamCommand({ StreamName: name, ShardCount: 1 }))
  await waitFor(() => client.send(new DescribeStreamSummaryCommand({ StreamName: name })), result => result.StreamDescriptionSummary?.StreamStatus === 'ACTIVE')
}

function put(client: ReturnType<typeof kinesis>, name: string, value: string) {
  return client.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.from(value) }))
}

describe('persistence', () => {
  it('keeps streams, records, tags and consumers across restarts', async () => {
    const path = directory()
    const arn = await withServer(path, async client => {
      await client.send(new CreateStreamCommand({ StreamName: 'kept', ShardCount: 2, Tags: { a: 'b' } }))
      const summary = await waitFor(() => client.send(new DescribeStreamSummaryCommand({ StreamName: 'kept' })), result => result.StreamDescriptionSummary?.StreamStatus === 'ACTIVE')
      await client.send(new PutRecordCommand({ StreamName: 'kept', PartitionKey: 'p', Data: Buffer.from('persisted'), ExplicitHashKey: '0' }))
      await client.send(new RegisterStreamConsumerCommand({ StreamARN: summary.StreamDescriptionSummary!.StreamARN, ConsumerName: 'kept-consumer' }))
      return summary.StreamDescriptionSummary!.StreamARN!
    })
    assert.ok(existsSync(join(path, DATABASE_FILE)))
    await withServer(path, async client => {
      const { ShardIterator } = await client.send(new GetShardIteratorCommand({ StreamName: 'kept', ShardId: 'shardId-000000000000', ShardIteratorType: 'TRIM_HORIZON' }))
      const { Records } = await client.send(new GetRecordsCommand({ ShardIterator }))
      assert.deepEqual(Records?.map(record => text(record.Data)), ['persisted'])
      assert.deepEqual((await client.send(new ListTagsForStreamCommand({ StreamName: 'kept' }))).Tags, [{ Key: 'a', Value: 'b' }])
      const consumers = await waitFor(() => client.send(new ListStreamConsumersCommand({ StreamARN: arn })), result => result.Consumers?.[0]?.ConsumerStatus === 'ACTIVE')
      assert.equal(consumers.Consumers?.[0]?.ConsumerName, 'kept-consumer')
      const next = await client.send(new PutRecordCommand({ StreamName: 'kept', PartitionKey: 'p', Data: Buffer.from('after'), ExplicitHashKey: '0' }))
      assert.ok(BigInt(next.SequenceNumber!) > BigInt(Records![0]!.SequenceNumber!))
    })
  })

  it('finishes state transitions that were pending when the server stopped', async () => {
    const path = directory()
    await withServer(path, async client => {
      await client.send(new CreateStreamCommand({ StreamName: 'pending', ShardCount: 3 }))
    }, { createStreamMs: 300 })
    await sleep(400)
    await withServer(path, async client => {
      const { StreamDescription } = await waitFor(() => client.send(new DescribeStreamCommand({ StreamName: 'pending' })), result => result.StreamDescription?.StreamStatus === 'ACTIVE', 2000)
      assert.equal(StreamDescription?.Shards?.length, 3)
    })
  })
})

describe('record expiry', () => {
  it('deletes a record past its retention period without a read', async () => {
    const path = directory()
    await withServer(path, async client => {
      const clock = rewindClock(25 * HOUR_MS)
      await createActive(client, 'aged')
      await put(client, 'aged', 'old')
      clock.mock.restore()
      await put(client, 'aged', 'new')
      await waitFor(async () => recordCount(path), count => count === 1)
      const { ShardIterator } = await client.send(new GetShardIteratorCommand({ StreamName: 'aged', ShardId: 'shardId-000000000000', ShardIteratorType: 'TRIM_HORIZON' }))
      const { Records } = await client.send(new GetRecordsCommand({ ShardIterator }))
      assert.deepEqual(Records?.map(record => text(record.Data)), ['new'])
    }, { expiryIntervalMs: 10 })
  })

  it('deletes the records that a shorter retention period makes too old', async () => {
    const path = directory()
    await withServer(path, async client => {
      const clock = rewindClock(25 * HOUR_MS)
      await createActive(client, 'shortened')
      await client.send(new IncreaseStreamRetentionPeriodCommand({ StreamName: 'shortened', RetentionPeriodHours: 48 }))
      await put(client, 'shortened', 'old')
      clock.mock.restore()
      await sleep(100)
      assert.equal(recordCount(path), 1)
      await client.send(new DecreaseStreamRetentionPeriodCommand({ StreamName: 'shortened', RetentionPeriodHours: 24 }))
      await waitFor(async () => recordCount(path), count => count === 0)
    }, { expiryIntervalMs: 10 })
  })

  it('deletes expired records at start-up', async () => {
    const path = directory()
    const clock = rewindClock(25 * HOUR_MS)
    await withServer(path, async client => {
      await createActive(client, 'restarted')
      await put(client, 'restarted', 'old')
    })
    clock.mock.restore()
    assert.equal(recordCount(path), 1)
    await withServer(path, async () => {
      await waitFor(async () => recordCount(path), count => count === 0)
    })
  })

  it('answers requests while it deletes a large backlog', async () => {
    const path = directory()
    const clock = rewindClock(25 * HOUR_MS)
    const sequenceNumber = await withServer(path, async client => {
      await createActive(client, 'backlog')
      return (await put(client, 'backlog', 'old')).SequenceNumber!
    })
    clock.mock.restore()
    insertBacklog(path, 'backlog', sequenceNumber, 30000)
    const target = await startTarget({ path })
    try {
      const response = await call(target.endpoint, 'ListStreams', {})
      assert.equal(response.status, 200)
      assert.ok(recordCount(path) > 0)
      await waitFor(async () => recordCount(path), count => count === 0, 30000)
    } finally {
      await target.close()
    }
  })
})

describe('disk space', () => {
  it('reduces the database file after the job deletes expired records', async () => {
    const path = directory()
    await withServer(path, async client => {
      const clock = rewindClock(25 * HOUR_MS)
      await createActive(client, 'expiring')
      await putMegabytes(client, 'expiring', 10)
      clock.mock.restore()
      const full = sizeOnDisk(path)
      assert.ok(full > 10 * 1024 * 1024)
      await waitFor(async () => sizeOnDisk(path), size => size < full / 4)
    }, { expiryIntervalMs: 10 })
  })

  it('reduces the database file after DeleteStream', async () => {
    const path = directory()
    await withServer(path, async client => {
      await createActive(client, 'deleted')
      await putMegabytes(client, 'deleted', 10)
      const full = sizeOnDisk(path)
      await client.send(new DeleteStreamCommand({ StreamName: 'deleted' }))
      await waitFor(async () => sizeOnDisk(path), size => size < full / 4)
    })
  })

  it('converts a database from an earlier version and keeps its data', async () => {
    const path = directory()
    const earlier = new SqliteBackend(path, { reclaimSpace: false })
    const target = await startTarget({ backend: earlier })
    const client = kinesis(target.endpoint)
    try {
      const clock = rewindClock(25 * HOUR_MS)
      await createActive(client, 'converted')
      await putMegabytes(client, 'converted', 10)
      clock.mock.restore()
      await put(client, 'converted', 'kept')
    } finally {
      client.destroy()
      await target.close()
      earlier.close()
    }
    assert.equal(autoVacuum(path), 0)
    assert.equal(recordCount(path), 1001)
    const full = sizeOnDisk(path)
    await withServer(path, async client => {
      await waitFor(async () => sizeOnDisk(path), size => size < full / 4)
      const { ShardIterator } = await client.send(new GetShardIteratorCommand({ StreamName: 'converted', ShardId: 'shardId-000000000000', ShardIteratorType: 'TRIM_HORIZON' }))
      const { Records } = await client.send(new GetRecordsCommand({ ShardIterator }))
      assert.deepEqual(Records?.map(record => text(record.Data)), ['kept'])
    }, { expiryIntervalMs: 10 })
    assert.equal(autoVacuum(path), 2)
  })
})
