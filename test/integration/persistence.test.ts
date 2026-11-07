import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, it } from 'node:test'
import {
  CreateStreamCommand, DescribeStreamCommand, DescribeStreamSummaryCommand, GetRecordsCommand, GetShardIteratorCommand,
  ListStreamConsumersCommand, ListTagsForStreamCommand, PutRecordCommand, RegisterStreamConsumerCommand,
} from '@aws-sdk/client-kinesis'
import { DATABASE_FILE } from '../../src/store/store.ts'
import { kinesis, startTarget, text, waitFor } from './helpers.ts'

function directory() {
  return mkdtempSync(join(tmpdir(), 'kinesis-data-'))
}

async function withServer<T>(path: string, work: (client: ReturnType<typeof kinesis>) => Promise<T>, createStreamMs = 20) {
  const target = await startTarget({ path, createStreamMs })
  const client = kinesis(target.endpoint)
  try {
    return await work(client)
  } finally {
    client.destroy()
    await target.close()
  }
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
    }, 300)
    await sleep(400)
    await withServer(path, async client => {
      const { StreamDescription } = await waitFor(() => client.send(new DescribeStreamCommand({ StreamName: 'pending' })), result => result.StreamDescription?.StreamStatus === 'ACTIVE', 2000)
      assert.equal(StreamDescription?.Shards?.length, 3)
    })
  })
})
