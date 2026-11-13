import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  CreateChannelCommand, CreateStreamCommand, DescribeAccountSettingsCommand, DescribeChannelCommand, DescribeStreamConsumerCommand,
  DescribeStreamSummaryCommand, GetRecordsCommand, GetResourcePolicyCommand, GetShardIteratorCommand, ListStreamsCommand, PutRecordCommand,
  PutResourcePolicyCommand, RegisterStreamConsumerCommand, SubscribeToShardCommand, UpdateAccountSettingsCommand, type KinesisClient,
} from '@aws-sdk/client-kinesis'
import { start, type KinesisLocal, type StartOptions } from '../../src/index.ts'
import { parseBody, send } from './http.ts'
import { kinesis, rejects, text, waitFor } from './helpers.ts'

let server: KinesisLocal
let client: KinesisClient

function startServer(options: Partial<StartOptions> = {}) {
  return start({
    port: 0,
    host: '127.0.0.1',
    createStreamMs: 20,
    deleteStreamMs: 20,
    updateStreamMs: 20,
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

async function reset(body?: string) {
  const response = await send(server.endpoint, { path: '/_control/reset', ...(body === undefined ? {} : { body }) })
  return { status: response.status, body: parseBody(response) as any }
}

async function activeStream(name: string, onDemand = false) {
  await client.send(new CreateStreamCommand(onDemand ? { StreamName: name, StreamModeDetails: { StreamMode: 'ON_DEMAND' } } : { StreamName: name, ShardCount: 1 }))
  const summary = await waitFor(
    () => client.send(new DescribeStreamSummaryCommand({ StreamName: name })),
    result => result.StreamDescriptionSummary?.StreamStatus === 'ACTIVE',
  )
  return summary.StreamDescriptionSummary!.StreamARN!
}

async function activeConsumer(streamArn: string, name: string) {
  const { Consumer } = await client.send(new RegisterStreamConsumerCommand({ StreamARN: streamArn, ConsumerName: name }))
  await waitFor(
    () => client.send(new DescribeStreamConsumerCommand({ ConsumerARN: Consumer!.ConsumerARN })),
    result => result.ConsumerDescription?.ConsumerStatus === 'ACTIVE',
  )
  return Consumer!.ConsumerARN!
}

async function records(name: string) {
  const { ShardIterator } = await client.send(new GetShardIteratorCommand({ StreamName: name, ShardId: 'shardId-000000000000', ShardIteratorType: 'TRIM_HORIZON' }))
  const { Records } = await client.send(new GetRecordsCommand({ ShardIterator }))
  return Records!.map(record => text(record.Data))
}

async function streamNames() {
  return (await client.send(new ListStreamsCommand({}))).StreamNames
}

describe('reset', () => {
  it('removes every stream with its records, consumers and policies', async () => {
    const orders = await activeStream('orders')
    await activeStream('payments')
    await client.send(new PutRecordCommand({ StreamName: 'orders', PartitionKey: 'p', Data: Buffer.from('order') }))
    const consumer = await activeConsumer(orders, 'reader')
    await client.send(new PutResourcePolicyCommand({ ResourceARN: orders, Policy: '{"Version":"2012-10-17","Statement":[]}' }))
    await client.send(new UpdateAccountSettingsCommand({ MinimumThroughputBillingCommitment: { Status: 'ENABLED' } }))
    assert.deepEqual(await reset(), { status: 200, body: { streams: ['orders', 'payments'] } })
    assert.deepEqual(await streamNames(), [])
    await rejects(client.send(new DescribeStreamConsumerCommand({ ConsumerARN: consumer })), 'ResourceNotFoundException')
    const recreated = await activeStream('orders')
    assert.deepEqual(await records('orders'), [])
    assert.equal((await client.send(new GetResourcePolicyCommand({ ResourceARN: recreated }))).Policy, '{}')
    const settings = await client.send(new DescribeAccountSettingsCommand({}))
    assert.equal(settings.MinimumThroughputBillingCommitment?.Status, 'DISABLED')
  })

  it('resets one stream and leaves the other streams alone', async () => {
    const orders = await activeStream('orders', true)
    const payments = await activeStream('payments')
    await client.send(new PutRecordCommand({ StreamName: 'payments', PartitionKey: 'p', Data: Buffer.from('payment') }))
    const reader = await activeConsumer(payments, 'reader')
    const { ChannelDescription } = await client.send(new CreateChannelCommand({
      ChannelName: 'archive',
      ServiceExecutionRoleARN: 'arn:aws:iam::000000000000:role/channel',
      StreamConfigurationList: [{ StreamARN: orders, RecordConfiguration: { RecordFormatType: 'JSON' } }],
      S3DestinationConfiguration: { StorageConfiguration: { BucketARN: 'arn:aws:s3:::example-bucket', ExpectedBucketOwner: '000000000000', CompressionType: 'GZIP' } },
    }))
    assert.deepEqual(await reset('{"stream": "orders"}'), { status: 200, body: { streams: ['orders'] } })
    assert.deepEqual(await streamNames(), ['payments'])
    await rejects(client.send(new DescribeChannelCommand({ ChannelARN: ChannelDescription!.ChannelARN })), 'ResourceNotFoundException')
    assert.deepEqual(await records('payments'), ['payment'])
    const described = await client.send(new DescribeStreamConsumerCommand({ ConsumerARN: reader }))
    assert.equal(described.ConsumerDescription?.ConsumerStatus, 'ACTIVE')
    assert.deepEqual(await reset('{"stream": "missing"}'), { status: 200, body: { streams: [] } })
  })

  it('ends an open SubscribeToShard stream with an error', async () => {
    const orders = await activeStream('orders')
    const consumer = await activeConsumer(orders, 'reader')
    const subscribe = async (consumerArn: string) => {
      const subscription = await client.send(new SubscribeToShardCommand({
        ConsumerARN: consumerArn,
        ShardId: 'shardId-000000000000',
        StartingPosition: { Type: 'TRIM_HORIZON' },
      }))
      const events = subscription.EventStream![Symbol.asyncIterator]()
      assert.ok((await events.next()).value?.SubscribeToShardEvent)
      return events
    }
    const events = await subscribe(consumer)
    await reset()
    await rejects(events.next(), 'ResourceNotFoundException', /orders/)
    const recreated = await activeConsumer(await activeStream('orders'), 'reader')
    await (await subscribe(recreated)).return?.()
  })

  it('rejects a body that is not a JSON object with a string stream member', async () => {
    for (const body of ['orders', '[]', '{"stream": 1}']) {
      const response = await reset(body)
      assert.equal(response.status, 400)
      assert.match(response.body.message, /JSON object/)
    }
  })

  it('offers the same reset through the object that start() returns', async () => {
    await activeStream('orders')
    await activeStream('payments')
    assert.deepEqual(server.reset('orders'), ['orders'])
    assert.deepEqual(server.reset(), ['payments'])
    assert.deepEqual(await streamNames(), [])
  })

  it('keeps the reset across a restart', async () => {
    const path = mkdtempSync(join(tmpdir(), 'kinesis-reset-'))
    let persistent = await startServer({ path })
    let persistentClient = kinesis(persistent.endpoint)
    try {
      await persistentClient.send(new CreateStreamCommand({ StreamName: 'orders', ShardCount: 1 }))
      assert.deepEqual(persistent.reset(), ['orders'])
      persistentClient.destroy()
      await persistent.close()
      persistent = await startServer({ path })
      persistentClient = kinesis(persistent.endpoint)
      assert.deepEqual((await persistentClient.send(new ListStreamsCommand({}))).StreamNames, [])
    } finally {
      persistentClient.destroy()
      await persistent.close()
    }
  })
})
