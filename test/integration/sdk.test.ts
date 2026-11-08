import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, it } from 'node:test'
import {
  AddTagsToStreamCommand, CreateChannelCommand, CreateStreamCommand, DecreaseStreamRetentionPeriodCommand, DeleteChannelCommand,
  DeleteResourcePolicyCommand, DeleteStreamCommand, DeregisterStreamConsumerCommand, DescribeAccountSettingsCommand,
  DescribeChannelCommand, DescribeLimitsCommand, DescribeStreamCommand, DescribeStreamConsumerCommand, DescribeStreamSummaryCommand,
  DisableEnhancedMonitoringCommand, EnableEnhancedMonitoringCommand, GetRecordsCommand, GetResourcePolicyCommand,
  GetShardIteratorCommand, IncreaseStreamRetentionPeriodCommand, ListChannelsCommand, ListShardsCommand, ListStreamConsumersCommand,
  ListStreamsCommand, ListTagsForResourceCommand, ListTagsForStreamCommand, MergeShardsCommand, PutRecordCommand, PutRecordsCommand,
  PutResourcePolicyCommand, RegisterStreamConsumerCommand, RemoveTagsFromStreamCommand, SplitShardCommand,
  StartStreamEncryptionCommand, StopStreamEncryptionCommand, SubscribeToShardCommand, TagResourceCommand, UntagResourceCommand,
  UpdateAccountSettingsCommand, UpdateChannelCommand, UpdateMaxRecordSizeCommand, UpdateShardCountCommand, UpdateStreamModeCommand,
  UpdateStreamRecordDistributionStrategyCommand, UpdateStreamWarmThroughputCommand, paginateListStreams,
  type KinesisClient, type Shard,
} from '@aws-sdk/client-kinesis'
import { kinesis, rejects, startTarget, text, unique, waitFor, type Target } from './helpers.ts'

let target: Target
let client: KinesisClient

before(async () => {
  target = await startTarget()
  client = kinesis(target.endpoint)
})

after(async () => {
  client.destroy()
  await target.close()
})

async function activeStream(name: string, shards = 1, extra: Record<string, unknown> = {}) {
  await client.send(new CreateStreamCommand({ StreamName: name, ShardCount: shards, ...extra }))
  const summary = await waitFor(
    () => client.send(new DescribeStreamSummaryCommand({ StreamName: name })),
    result => result.StreamDescriptionSummary?.StreamStatus === 'ACTIVE',
  )
  return summary.StreamDescriptionSummary!
}

async function onDemandStream(name: string) {
  await client.send(new CreateStreamCommand({ StreamName: name, StreamModeDetails: { StreamMode: 'ON_DEMAND' } }))
  return (await waitFor(
    () => client.send(new DescribeStreamSummaryCommand({ StreamName: name })),
    result => result.StreamDescriptionSummary?.StreamStatus === 'ACTIVE',
  )).StreamDescriptionSummary!
}

async function untilActive(name: string) {
  return waitFor(
    () => client.send(new DescribeStreamCommand({ StreamName: name })),
    result => result.StreamDescription?.StreamStatus === 'ACTIVE',
  )
}

async function readAll(streamName: string, shardId: string) {
  const { ShardIterator } = await client.send(new GetShardIteratorCommand({ StreamName: streamName, ShardId: shardId, ShardIteratorType: 'TRIM_HORIZON' }))
  const { Records } = await client.send(new GetRecordsCommand({ ShardIterator }))
  return Records ?? []
}

function checkLineage(shards: Shard[]) {
  const byId = new Map(shards.map(shard => [shard.ShardId!, shard]))
  const open = shards.filter(shard => !shard.SequenceNumberRange?.EndingSequenceNumber)
    .sort((a, b) => (BigInt(a.HashKeyRange!.StartingHashKey!) < BigInt(b.HashKeyRange!.StartingHashKey!) ? -1 : 1))
  let next = 0n
  for (const shard of open) {
    assert.equal(BigInt(shard.HashKeyRange!.StartingHashKey!), next)
    next = BigInt(shard.HashKeyRange!.EndingHashKey!) + 1n
  }
  assert.equal(next, 2n ** 128n)
  for (const shard of shards) {
    for (const parent of [shard.ParentShardId, shard.AdjacentParentShardId]) {
      if (parent === undefined) continue
      assert.ok(byId.get(parent)?.SequenceNumberRange?.EndingSequenceNumber, `${shard.ShardId} has an open parent ${parent}`)
    }
  }
  return open
}

describe('streams', () => {
  it('creates, describes, lists and deletes a stream by name and by ARN', async () => {
    const name = unique('streams')
    await client.send(new CreateStreamCommand({ StreamName: name, ShardCount: 2, Tags: { owner: 'tests' } }))
    const creating = await client.send(new DescribeStreamCommand({ StreamName: name }))
    assert.equal(creating.StreamDescription?.StreamStatus, 'CREATING')
    assert.deepEqual(creating.StreamDescription?.Shards, [])
    const active = await untilActive(name)
    const arn = active.StreamDescription!.StreamARN!
    assert.match(arn, new RegExp(`^arn:aws:kinesis:[a-z0-9-]+:\\d{12}:stream/${name}$`))
    assert.equal(active.StreamDescription?.Shards?.length, 2)
    assert.equal(active.StreamDescription?.StreamModeDetails?.StreamMode, 'PROVISIONED')
    const byArn = await client.send(new DescribeStreamSummaryCommand({ StreamARN: arn }))
    assert.equal(byArn.StreamDescriptionSummary?.OpenShardCount, 2)
    assert.equal(byArn.StreamDescriptionSummary?.ConsumerCount, 0)
    assert.ok(byArn.StreamDescriptionSummary?.StreamCreationTimestamp instanceof Date)
    assert.ok(Math.abs(byArn.StreamDescriptionSummary!.StreamCreationTimestamp!.getTime() - Date.now()) < 60000)
    const tags = await client.send(new ListTagsForStreamCommand({ StreamARN: arn }))
    assert.deepEqual(tags.Tags, [{ Key: 'owner', Value: 'tests' }])
    const page = await client.send(new DescribeStreamCommand({ StreamName: name, Limit: 1 }))
    assert.equal(page.StreamDescription?.Shards?.length, 1)
    assert.equal(page.StreamDescription?.HasMoreShards, true)
    await rejects(client.send(new DescribeStreamCommand({ StreamName: name, StreamARN: `${arn}x` })), 'InvalidArgumentException')
    await client.send(new DeleteStreamCommand({ StreamARN: arn }))
    await waitFor(
      () => client.send(new DescribeStreamCommand({ StreamName: name })).then(() => 'present', error => error.name),
      outcome => outcome === 'ResourceNotFoundException',
    )
  })

  it('pages through streams with NextToken', async () => {
    const prefix = unique('page')
    for (let i = 0; i < 12; i++) await client.send(new CreateStreamCommand({ StreamName: `${prefix}-${i}`, ShardCount: 1 }))
    const names: string[] = []
    for await (const page of paginateListStreams({ client, pageSize: 5 }, {})) names.push(...(page.StreamNames ?? []))
    assert.equal(names.filter(name => name.startsWith(prefix)).length, 12)
    assert.deepEqual(names, [...names].sort())
    const first = await client.send(new ListStreamsCommand({ Limit: 1 }))
    assert.equal(first.StreamSummaries?.length, 1)
    assert.equal(first.StreamSummaries?.[0]?.StreamName, first.StreamNames?.[0])
  })

  it('rejects duplicate streams and the shard limit', async () => {
    const name = unique('duplicate')
    await activeStream(name)
    await rejects(client.send(new CreateStreamCommand({ StreamName: name, ShardCount: 1 })), 'ResourceInUseException', /already exists/)
    await rejects(client.send(new CreateStreamCommand({ StreamName: unique('huge'), ShardCount: 100000 })), 'LimitExceededException', /shard limit/)
    await rejects(client.send(new DescribeStreamCommand({ StreamName: unique('missing') })), 'ResourceNotFoundException', /not found/)
  })
})

for (const transport of ['http2', 'http1'] as const) {
  describe(`records over ${transport === 'http2' ? 'HTTP/2' : 'HTTP/1.1'}`, () => {
    let records: KinesisClient

    before(() => {
      records = kinesis(target.endpoint, transport)
    })

    after(() => records.destroy())

    it('puts records and reads them back from every iterator type', async () => {
      const name = unique(`records-${transport}`)
      const { StreamARN } = await activeStream(name, 2)
      const first = await records.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.from('one') }))
      const second = await records.send(new PutRecordCommand({ StreamARN, PartitionKey: 'p', Data: Buffer.from('two') }))
      const batch = await records.send(new PutRecordsCommand({
        StreamName: name,
        Records: Array.from({ length: 10 }, (_, i) => ({ PartitionKey: `key-${i}`, Data: Buffer.from(`batch ${i}`) })),
      }))
      assert.equal(batch.FailedRecordCount, 0)
      assert.equal(batch.Records?.length, 10)
      assert.ok(BigInt(second.SequenceNumber!) > BigInt(first.SequenceNumber!))
      const shardId = first.ShardId!
      const all = await readAll(name, shardId)
      assert.deepEqual(all.slice(0, 2).map(record => text(record.Data)), ['one', 'two'])
      assert.ok(all.every(record => record.ApproximateArrivalTimestamp instanceof Date))
      const read = async (type: 'AT_SEQUENCE_NUMBER' | 'AFTER_SEQUENCE_NUMBER' | 'LATEST' | 'AT_TIMESTAMP', extra: Record<string, unknown> = {}) => {
        const { ShardIterator } = await records.send(new GetShardIteratorCommand({ StreamName: name, ShardId: shardId, ShardIteratorType: type, ...extra }))
        return records.send(new GetRecordsCommand({ ShardIterator, Limit: 1 }))
      }
      assert.equal(text((await read('AT_SEQUENCE_NUMBER', { StartingSequenceNumber: second.SequenceNumber })).Records?.[0]?.Data), 'two')
      assert.notEqual(text((await read('AFTER_SEQUENCE_NUMBER', { StartingSequenceNumber: first.SequenceNumber })).Records?.[0]?.Data), 'one')
      assert.equal(text((await read('AT_TIMESTAMP', { Timestamp: new Date(Date.now() - 60000) })).Records?.[0]?.Data), 'one')
      const latest = await read('LATEST')
      assert.deepEqual(latest.Records, [])
      await records.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.from('three') }))
      const afterLatest = await records.send(new GetRecordsCommand({ ShardIterator: latest.NextShardIterator }))
      assert.deepEqual(afterLatest.Records?.map(record => text(record.Data)), ['three'])
    })

    it('honours DryRun and reports invalid requests', async () => {
      const name = unique(`dry-${transport}`)
      await activeStream(name)
      await rejects(records.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.from('x'), DryRun: true })), 'DryRunOperationException')
      assert.equal((await readAll(name, 'shardId-000000000000')).length, 0)
      await rejects(records.send(new PutRecordCommand({ StreamName: name, PartitionKey: '', Data: Buffer.from('x') })), 'ValidationException', /partitionKey/)
      await rejects(records.send(new GetRecordsCommand({ ShardIterator: 'AAAA' })), 'InvalidArgumentException', /Invalid ShardIterator/)
      await rejects(records.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.alloc(1048577) })), 'ValidationException', /lim=1048577/)
    })
  })
}

describe('MillisBehindLatest', () => {
  it('reports the lag of a read that leaves records unread and 0 at the newest record', async () => {
    const name = unique('behind')
    await activeStream(name)
    await client.send(new PutRecordsCommand({
      StreamName: name,
      Records: ['one', 'two', 'three'].map(value => ({ PartitionKey: 'p', Data: Buffer.from(value) })),
    }))
    await sleep(100)
    const { ShardIterator } = await client.send(new GetShardIteratorCommand({ StreamName: name, ShardId: 'shardId-000000000000', ShardIteratorType: 'TRIM_HORIZON' }))
    const first = await client.send(new GetRecordsCommand({ ShardIterator, Limit: 1 }))
    assert.equal(first.Records?.length, 1)
    assert.ok(first.MillisBehindLatest! >= 50, `MillisBehindLatest was ${first.MillisBehindLatest}`)
    const rest = await client.send(new GetRecordsCommand({ ShardIterator: first.NextShardIterator }))
    assert.equal(rest.Records?.length, 2)
    assert.equal(rest.MillisBehindLatest, 0)
  })

  it('follows the same rule in SubscribeToShard events', async () => {
    const name = unique('behind-events')
    const { StreamARN } = await activeStream(name)
    for (let i = 0; i < 4; i++) {
      await client.send(new PutRecordsCommand({
        StreamName: name,
        Records: Array.from({ length: 500 }, () => ({ PartitionKey: 'p', Data: Buffer.from('x') })),
      }))
    }
    const { Consumer } = await client.send(new RegisterStreamConsumerCommand({ StreamARN, ConsumerName: 'lag' }))
    await waitFor(
      () => client.send(new DescribeStreamConsumerCommand({ StreamARN, ConsumerName: 'lag' })),
      result => result.ConsumerDescription?.ConsumerStatus === 'ACTIVE',
    )
    const subscription = await client.send(new SubscribeToShardCommand({
      ConsumerARN: Consumer!.ConsumerARN,
      ShardId: 'shardId-000000000000',
      StartingPosition: { Type: 'TRIM_HORIZON' },
    }))
    const events: { records: number, millisBehindLatest: number }[] = []
    for await (const event of subscription.EventStream!) {
      const records = event.SubscribeToShardEvent?.Records?.length ?? 0
      if (records) events.push({ records, millisBehindLatest: event.SubscribeToShardEvent!.MillisBehindLatest! })
      if (events.reduce((total, seen) => total + seen.records, 0) >= 2000) break
    }
    assert.deepEqual(events.map(event => event.records), [1000, 1000])
    assert.ok(events[0]!.millisBehindLatest > 0, `MillisBehindLatest was ${events[0]!.millisBehindLatest}`)
    assert.equal(events[1]!.millisBehindLatest, 0)
  })
})

describe('shards', () => {
  it('splits and merges shards and reports child shards at the end of a parent', async () => {
    const name = unique('reshard')
    await activeStream(name, 2)
    await client.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.from('before'), ExplicitHashKey: '0' }))
    await client.send(new SplitShardCommand({ StreamName: name, ShardToSplit: 'shardId-000000000000', NewStartingHashKey: (2n ** 126n).toString() }))
    await untilActive(name)
    await client.send(new MergeShardsCommand({ StreamName: name, ShardToMerge: 'shardId-000000000002', AdjacentShardToMerge: 'shardId-000000000003' }))
    const { StreamDescription } = await untilActive(name)
    const open = checkLineage(StreamDescription!.Shards!)
    assert.deepEqual(open.map(shard => shard.ShardId), ['shardId-000000000004', 'shardId-000000000001'])
    const { ShardIterator } = await client.send(new GetShardIteratorCommand({ StreamName: name, ShardId: 'shardId-000000000000', ShardIteratorType: 'TRIM_HORIZON' }))
    let iterator = ShardIterator
    let childShards
    let millisBehindLatest
    for (let i = 0; i < 5 && iterator; i++) {
      const page = await client.send(new GetRecordsCommand({ ShardIterator: iterator }))
      iterator = page.NextShardIterator
      childShards = page.ChildShards
      millisBehindLatest = page.MillisBehindLatest
    }
    assert.equal(iterator, undefined)
    assert.equal(millisBehindLatest, 0)
    assert.deepEqual(childShards?.map(child => child.ShardId), ['shardId-000000000002', 'shardId-000000000003'])
    assert.deepEqual(childShards?.[0]?.ParentShards, ['shardId-000000000000'])
    await rejects(client.send(new SplitShardCommand({ StreamName: name, ShardToSplit: 'shardId-000000000000', NewStartingHashKey: '100' })), 'InvalidArgumentException', /already been merged or split/)
  })

  it('filters and pages shards with ListShards', async () => {
    const name = unique('list-shards')
    const { StreamARN } = await activeStream(name, 3)
    await client.send(new SplitShardCommand({ StreamName: name, ShardToSplit: 'shardId-000000000001', NewStartingHashKey: (2n ** 127n).toString() }))
    await untilActive(name)
    const all = await client.send(new ListShardsCommand({ StreamARN }))
    assert.equal(all.Shards?.length, 5)
    const latest = await client.send(new ListShardsCommand({ StreamName: name, ShardFilter: { Type: 'AT_LATEST' } }))
    assert.deepEqual(latest.Shards?.map(shard => shard.ShardId), ['shardId-000000000000', 'shardId-000000000002', 'shardId-000000000003', 'shardId-000000000004'])
    const horizon = await client.send(new ListShardsCommand({ StreamName: name, ShardFilter: { Type: 'AT_TRIM_HORIZON' } }))
    assert.deepEqual(horizon.Shards?.map(shard => shard.ShardId), ['shardId-000000000000', 'shardId-000000000001', 'shardId-000000000002'])
    const afterShard = await client.send(new ListShardsCommand({ StreamName: name, ShardFilter: { Type: 'AFTER_SHARD_ID', ShardId: 'shardId-000000000002' } }))
    assert.deepEqual(afterShard.Shards?.map(shard => shard.ShardId), ['shardId-000000000003', 'shardId-000000000004'])
    const first = await client.send(new ListShardsCommand({ StreamName: name, MaxResults: 2 }))
    assert.equal(first.Shards?.length, 2)
    const second = await client.send(new ListShardsCommand({ NextToken: first.NextToken, MaxResults: 10 }))
    assert.deepEqual([...first.Shards!, ...second.Shards!].map(shard => shard.ShardId), all.Shards!.map(shard => shard.ShardId))
    await rejects(client.send(new ListShardsCommand({})), 'InvalidArgumentException', /Either NextToken or StreamName/)
  })

  it('scales the shard count up and down with UpdateShardCount', async () => {
    const name = unique('scale')
    await activeStream(name, 3)
    const up = await client.send(new UpdateShardCountCommand({ StreamName: name, TargetShardCount: 5, ScalingType: 'UNIFORM_SCALING' }))
    assert.equal(up.CurrentShardCount, 3)
    assert.equal(up.TargetShardCount, 5)
    let description = await untilActive(name)
    assert.equal(checkLineage(description.StreamDescription!.Shards!).length, 5)
    await client.send(new UpdateShardCountCommand({ StreamName: name, TargetShardCount: 3, ScalingType: 'UNIFORM_SCALING' }))
    description = await untilActive(name)
    const open = checkLineage(description.StreamDescription!.Shards!)
    assert.equal(open.length, 3)
    for (const shard of open) assert.ok(shard.ParentShardId !== undefined)
    await rejects(client.send(new UpdateShardCountCommand({ StreamName: name, TargetShardCount: 7, ScalingType: 'UNIFORM_SCALING' })), 'LimitExceededException', /double/)
    const { Records } = await client.send(new PutRecordsCommand({ StreamName: name, Records: Array.from({ length: 30 }, (_, i) => ({ PartitionKey: `k${i}`, Data: Buffer.from('x') })) }))
    assert.ok(Records!.every(record => open.some(shard => shard.ShardId === record.ShardId)))
  })
})

describe('retention and tags', () => {
  it('changes the retention period within 24 and 8760 hours', async () => {
    const name = unique('retention')
    await activeStream(name)
    await client.send(new IncreaseStreamRetentionPeriodCommand({ StreamName: name, RetentionPeriodHours: 8760 }))
    await rejects(client.send(new IncreaseStreamRetentionPeriodCommand({ StreamName: name, RetentionPeriodHours: 8761 })), 'InvalidArgumentException', /8760/)
    await client.send(new DecreaseStreamRetentionPeriodCommand({ StreamName: name, RetentionPeriodHours: 48 }))
    await rejects(client.send(new DecreaseStreamRetentionPeriodCommand({ StreamName: name, RetentionPeriodHours: 23 })), 'InvalidArgumentException', /24 hours/)
    const summary = await client.send(new DescribeStreamSummaryCommand({ StreamName: name }))
    assert.equal(summary.StreamDescriptionSummary?.RetentionPeriodHours, 48)
  })

  it('tags streams and consumers through both tagging APIs', async () => {
    const name = unique('tags')
    const { StreamARN } = await activeStream(name)
    await client.send(new AddTagsToStreamCommand({ StreamName: name, Tags: { a: '1', b: '2' } }))
    await client.send(new TagResourceCommand({ ResourceARN: StreamARN, Tags: { c: '3' } }))
    await client.send(new UntagResourceCommand({ ResourceARN: StreamARN, TagKeys: ['a'] }))
    await client.send(new RemoveTagsFromStreamCommand({ StreamName: name, TagKeys: ['b'] }))
    assert.deepEqual((await client.send(new ListTagsForResourceCommand({ ResourceARN: StreamARN }))).Tags, [{ Key: 'c', Value: '3' }])
    const { Consumer } = await client.send(new RegisterStreamConsumerCommand({ StreamARN, ConsumerName: 'tagged', Tags: { team: 'x' } }))
    await client.send(new TagResourceCommand({ ResourceARN: Consumer!.ConsumerARN, Tags: { env: 'y' } }))
    assert.deepEqual((await client.send(new ListTagsForResourceCommand({ ResourceARN: Consumer!.ConsumerARN }))).Tags, [{ Key: 'env', Value: 'y' }, { Key: 'team', Value: 'x' }])
    await rejects(client.send(new TagResourceCommand({ ResourceARN: StreamARN, Tags: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v'])) })), 'InvalidArgumentException', /50 tags/)
  })
})

describe('capacity and limits', () => {
  it('creates on-demand streams and switches capacity modes', async () => {
    const name = unique('on-demand')
    const summary = await onDemandStream(name)
    assert.equal(summary.StreamModeDetails?.StreamMode, 'ON_DEMAND')
    assert.equal(summary.OpenShardCount, 4)
    await rejects(client.send(new UpdateShardCountCommand({ StreamName: name, TargetShardCount: 8, ScalingType: 'UNIFORM_SCALING' })), 'InvalidArgumentException', /ON_DEMAND/)
    await client.send(new UpdateStreamModeCommand({ StreamARN: summary.StreamARN, StreamModeDetails: { StreamMode: 'PROVISIONED' } }))
    await waitFor(
      () => client.send(new DescribeStreamSummaryCommand({ StreamName: name })),
      result => result.StreamDescriptionSummary?.StreamStatus === 'ACTIVE' && result.StreamDescriptionSummary.StreamModeDetails?.StreamMode === 'PROVISIONED',
    )
    const limits = await client.send(new DescribeLimitsCommand({}))
    assert.ok(limits.ShardLimit! > 0)
    assert.ok(limits.OpenShardCount! >= 4)
    assert.equal(limits.OnDemandStreamCountLimit, 50)
  })

  it('raises the maximum record size', async () => {
    const name = unique('large-records')
    const { StreamARN } = await activeStream(name)
    await rejects(client.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.alloc(2 * 1024 * 1024) })), 'ValidationException', /less than or equal to 1048576/)
    await client.send(new UpdateMaxRecordSizeCommand({ StreamARN, MaxRecordSizeInKiB: 10240 }))
    await client.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.alloc(2 * 1024 * 1024, 1) }))
    const [record] = await readAll(name, 'shardId-000000000000')
    assert.equal(record?.Data?.length, 2 * 1024 * 1024)
    const summary = await client.send(new DescribeStreamSummaryCommand({ StreamName: name }))
    assert.equal(summary.StreamDescriptionSummary?.MaxRecordSizeInKiB, 10240)
  })

  it('manages warm throughput, record distribution and account settings', async () => {
    const name = unique('warm')
    const { StreamARN } = await onDemandStream(name)
    await client.send(new UpdateAccountSettingsCommand({ MinimumThroughputBillingCommitment: { Status: 'DISABLED' } }))
    await rejects(client.send(new UpdateStreamWarmThroughputCommand({ StreamARN, WarmThroughputMiBps: 10 })), 'InvalidArgumentException', /MinimumThroughputBillingCommitment/)
    const enabled = await client.send(new UpdateAccountSettingsCommand({ MinimumThroughputBillingCommitment: { Status: 'ENABLED' } }))
    assert.equal(enabled.MinimumThroughputBillingCommitment?.Status, 'ENABLED')
    assert.ok(enabled.MinimumThroughputBillingCommitment?.StartedAt instanceof Date)
    const settings = await client.send(new DescribeAccountSettingsCommand({}))
    assert.equal(settings.MinimumThroughputBillingCommitment?.Status, 'ENABLED')
    const warm = await client.send(new UpdateStreamWarmThroughputCommand({ StreamARN, WarmThroughputMiBps: 10 }))
    assert.equal(warm.WarmThroughput?.TargetMiBps, 10)
    await waitFor(
      () => client.send(new DescribeStreamSummaryCommand({ StreamName: name })),
      result => result.StreamDescriptionSummary?.StreamStatus === 'ACTIVE' && result.StreamDescriptionSummary.WarmThroughput?.CurrentMiBps === 10,
    )
    await client.send(new UpdateStreamRecordDistributionStrategyCommand({ StreamARN, RecordDistributionStrategy: 'AUTO' }))
    const auto = await client.send(new PutRecordsCommand({ StreamName: name, Records: Array.from({ length: 40 }, () => ({ Data: Buffer.from('a') })) }))
    assert.ok(new Set(auto.Records!.map(record => record.ShardId)).size > 1)
    await client.send(new UpdateAccountSettingsCommand({ MinimumThroughputBillingCommitment: { Status: 'DISABLED' } }))
    const provisioned = unique('provisioned')
    const created = await activeStream(provisioned)
    await rejects(client.send(new UpdateStreamRecordDistributionStrategyCommand({ StreamARN: created.StreamARN, RecordDistributionStrategy: 'AUTO' })), 'InvalidArgumentException')
  })
})

describe('enhanced fan-out', () => {
  it('registers consumers and pushes records with SubscribeToShard', async () => {
    const name = unique('fan-out')
    const { StreamARN } = await activeStream(name)
    await client.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.from('backlog') }))
    const { Consumer } = await client.send(new RegisterStreamConsumerCommand({ StreamARN, ConsumerName: 'reader' }))
    assert.equal(Consumer?.ConsumerStatus, 'CREATING')
    assert.match(Consumer!.ConsumerARN!, new RegExp(`^${StreamARN}/consumer/reader:\\d+$`))
    await rejects(client.send(new RegisterStreamConsumerCommand({ StreamARN, ConsumerName: 'reader' })), 'ResourceInUseException')
    await waitFor(
      () => client.send(new DescribeStreamConsumerCommand({ StreamARN, ConsumerName: 'reader' })),
      result => result.ConsumerDescription?.ConsumerStatus === 'ACTIVE',
    )
    const listed = await client.send(new ListStreamConsumersCommand({ StreamARN }))
    assert.deepEqual(listed.Consumers?.map(consumer => consumer.ConsumerName), ['reader'])
    const summary = await client.send(new DescribeStreamSummaryCommand({ StreamName: name }))
    assert.equal(summary.StreamDescriptionSummary?.ConsumerCount, 1)
    const subscription = await client.send(new SubscribeToShardCommand({
      ConsumerARN: Consumer!.ConsumerARN,
      ShardId: 'shardId-000000000000',
      StartingPosition: { Type: 'TRIM_HORIZON' },
    }))
    const received: string[] = []
    let continuation: string | undefined
    setTimeout(() => {
      client.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.from('live') })).catch(() => {})
    }, 300)
    for await (const event of subscription.EventStream!) {
      const records = event.SubscribeToShardEvent?.Records ?? []
      received.push(...records.map(record => text(record.Data)))
      continuation = event.SubscribeToShardEvent?.ContinuationSequenceNumber ?? continuation
      if (received.length >= 2) break
    }
    assert.deepEqual(received, ['backlog', 'live'])
    assert.ok(continuation)
    await rejects(client.send(new SubscribeToShardCommand({
      ConsumerARN: Consumer!.ConsumerARN,
      ShardId: 'shardId-000000000000',
      StartingPosition: { Type: 'LATEST' },
    })), 'ResourceInUseException', /5 seconds/)
    await rejects(client.send(new DeleteStreamCommand({ StreamName: name })), 'ResourceInUseException', /consumers/)
    await client.send(new DeregisterStreamConsumerCommand({ ConsumerARN: Consumer!.ConsumerARN }))
    await waitFor(
      () => client.send(new DescribeStreamConsumerCommand({ ConsumerARN: Consumer!.ConsumerARN })).then(() => 'present', error => error.name),
      outcome => outcome === 'ResourceNotFoundException',
    )
    await client.send(new DeleteStreamCommand({ StreamName: name, EnforceConsumerDeletion: true }))
  })
})

describe('encryption and monitoring', () => {
  it('encrypts new records and toggles enhanced monitoring', async () => {
    const name = unique('encryption')
    await activeStream(name)
    await client.send(new StartStreamEncryptionCommand({ StreamName: name, EncryptionType: 'KMS', KeyId: 'alias/aws/kinesis' }))
    let description = await untilActive(name)
    assert.equal(description.StreamDescription?.EncryptionType, 'KMS')
    assert.equal(description.StreamDescription?.KeyId, 'alias/aws/kinesis')
    const put = await client.send(new PutRecordCommand({ StreamName: name, PartitionKey: 'p', Data: Buffer.from('secret') }))
    assert.equal(put.EncryptionType, 'KMS')
    assert.equal((await readAll(name, 'shardId-000000000000'))[0]?.EncryptionType, 'KMS')
    await client.send(new StopStreamEncryptionCommand({ StreamName: name, EncryptionType: 'KMS', KeyId: 'alias/aws/kinesis' }))
    description = await untilActive(name)
    assert.equal(description.StreamDescription?.EncryptionType, 'NONE')
    const enabled = await client.send(new EnableEnhancedMonitoringCommand({ StreamName: name, ShardLevelMetrics: ['ALL'] }))
    assert.deepEqual(enabled.CurrentShardLevelMetrics, [])
    assert.equal(enabled.DesiredShardLevelMetrics?.length, 7)
    const disabled = await client.send(new DisableEnhancedMonitoringCommand({ StreamName: name, ShardLevelMetrics: ['IncomingBytes'] }))
    assert.equal(disabled.DesiredShardLevelMetrics?.length, 6)
    assert.ok(!disabled.DesiredShardLevelMetrics?.includes('IncomingBytes'))
  })
})

describe('resource policies', () => {
  it('stores, returns and deletes a policy', async () => {
    const name = unique('policy')
    const { StreamARN } = await activeStream(name)
    const policy = JSON.stringify({ Version: '2012-10-17', Statement: [] })
    assert.equal((await client.send(new GetResourcePolicyCommand({ ResourceARN: StreamARN }))).Policy, '{}')
    await client.send(new PutResourcePolicyCommand({ ResourceARN: StreamARN, Policy: policy }))
    assert.equal((await client.send(new GetResourcePolicyCommand({ ResourceARN: StreamARN }))).Policy, policy)
    await client.send(new DeleteResourcePolicyCommand({ ResourceARN: StreamARN }))
    assert.equal((await client.send(new GetResourcePolicyCommand({ ResourceARN: StreamARN }))).Policy, '{}')
    await rejects(client.send(new PutResourcePolicyCommand({ ResourceARN: StreamARN, Policy: 'not json' })), 'InvalidArgumentException')
    await rejects(client.send(new GetResourcePolicyCommand({ ResourceARN: `${StreamARN}-missing` })), 'ResourceNotFoundException')
  })
})

describe('channels', () => {
  it('creates, lists, updates and deletes a channel', async () => {
    const streamName = unique('channel-source')
    const { StreamARN } = await onDemandStream(streamName)
    const provisioned = await activeStream(unique('channel-provisioned'))
    const channelName = unique('channel')
    const destination = {
      StorageConfiguration: { BucketARN: 'arn:aws:s3:::example-bucket', ExpectedBucketOwner: '000000000000', CompressionType: 'GZIP' as const },
    }
    const request = {
      ChannelName: channelName,
      ServiceExecutionRoleARN: 'arn:aws:iam::000000000000:role/channel',
      StreamConfigurationList: [{ StreamARN, RecordConfiguration: { RecordFormatType: 'JSON' as const } }],
      S3DestinationConfiguration: destination,
    }
    await rejects(client.send(new CreateChannelCommand({ ...request, StreamConfigurationList: [{ StreamARN: provisioned.StreamARN, RecordConfiguration: { RecordFormatType: 'JSON' } }] })), 'InvalidArgumentException', /ON_DEMAND/)
    const created = await client.send(new CreateChannelCommand(request))
    const channelARN = created.ChannelDescription!.ChannelARN!
    assert.equal(created.ChannelDescription?.ChannelStatus, 'CREATING')
    await waitFor(
      () => client.send(new DescribeChannelCommand({ ChannelARN: channelARN })),
      result => result.ChannelDescription?.ChannelStatus === 'ACTIVE',
    )
    const listed = await client.send(new ListChannelsCommand({ StreamFilter: [{ StreamARN }] }))
    assert.deepEqual(listed.ChannelSummaries?.map(channel => [channel.ChannelName, channel.ChannelDestinationType]), [[channelName, 'S3']])
    const summary = await client.send(new DescribeStreamSummaryCommand({ StreamARN }))
    assert.equal(summary.StreamDescriptionSummary?.ChannelCount, 1)
    const updated = await client.send(new UpdateChannelCommand({ ChannelARN: channelARN, S3DestinationConfiguration: { DataFreshnessInSeconds: 60 } }))
    assert.equal(updated.ChannelDescription?.S3DestinationConfiguration?.DataFreshnessInSeconds, 60)
    await rejects(client.send(new DeleteStreamCommand({ StreamARN })), 'ResourceInUseException', /channels/)
    await waitFor(
      () => client.send(new DescribeChannelCommand({ ChannelARN: channelARN })),
      result => result.ChannelDescription?.ChannelStatus === 'ACTIVE',
    )
    await client.send(new DeleteChannelCommand({ ChannelARN: channelARN }))
    await waitFor(
      () => client.send(new DescribeChannelCommand({ ChannelARN: channelARN })).then(() => 'present', error => error.name),
      outcome => outcome === 'ResourceNotFoundException',
    )
    await client.send(new DeleteStreamCommand({ StreamARN }))
  })
})
