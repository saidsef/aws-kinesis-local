import { invalidArgument, limitExceeded, resourceInUse } from '../errors.ts'
import { POW_2_128, shardIdName, stringifySequence } from '../kinesis/sequence.ts'
import type { Store } from '../store/store.ts'
import type { ShardDoc, StreamDoc, StreamMode } from '../store/types.ts'
import {
  ON_DEMAND_SHARD_COUNT, ON_DEMAND_STREAM_LIMIT, account, applyTags, decodeToken, encodeToken, getStream, isOpen,
  provisionedOpenShards, publicView, shardLimitMessage, streamArn, streamMode, streamNameOf,
  type Context, type Input,
} from './common.ts'

const SEQ_ADJUST_MS = 2000

function uniformShards(count: number, createTime: number, firstIndex = 0): ShardDoc[] {
  const width = POW_2_128 / BigInt(count)
  const shards: ShardDoc[] = []
  for (let i = 0; i < count; i++) {
    const shardIx = firstIndex + i
    shards.push({
      HashKeyRange: {
        StartingHashKey: (width * BigInt(i)).toString(),
        EndingHashKey: ((i < count - 1 ? width * BigInt(i + 1) : POW_2_128) - 1n).toString(),
      },
      SequenceNumberRange: {
        StartingSequenceNumber: stringifySequence({ shardCreateTime: createTime, shardIx }),
      },
      ShardId: shardIdName(shardIx),
    })
  }
  return shards
}

export function requireBillingCommitment(context: Context, parameter: string) {
  const status = context.store.settings.MinimumThroughputBillingCommitment.Status
  if (status === 'DISABLED') {
    throw invalidArgument(`${parameter} requires MinimumThroughputBillingCommitment to be enabled for account ${account(context)}.`)
  }
}

export function createStream(context: Context, data: Input) {
  const name = data.StreamName as string
  const { store } = context
  if (store.streams.has(name)) throw resourceInUse(`Stream ${name} under account ${account(context)} already exists.`)
  const mode: StreamMode = data.StreamModeDetails?.StreamMode ?? 'PROVISIONED'
  let shardCount: number
  if (mode === 'ON_DEMAND') {
    if (data.ShardCount != null) throw invalidArgument('ShardCount must not be specified for a stream in ON_DEMAND capacity mode.')
    const onDemand = [...store.streams.values()].filter(stream => streamMode(stream) === 'ON_DEMAND').length
    if (onDemand >= ON_DEMAND_STREAM_LIMIT) {
      throw limitExceeded(`This request would exceed the limit of ${ON_DEMAND_STREAM_LIMIT} ON_DEMAND streams for the account ${account(context)} in ${store.options.region}.`)
    }
    shardCount = ON_DEMAND_SHARD_COUNT
  } else {
    shardCount = data.ShardCount as number
    if (data.RecordDistributionStrategy === 'AUTO') throw invalidArgument('RecordDistributionStrategy AUTO is supported only for streams in ON_DEMAND capacity mode.')
    if (data.WarmThroughputMiBps != null) throw invalidArgument('WarmThroughputMiBps is supported only for streams in ON_DEMAND capacity mode.')
    const shardSum = provisionedOpenShards(context)
    if (shardSum + shardCount > store.options.shardLimit) throw limitExceeded(shardLimitMessage(context, shardSum, shardCount))
  }
  if (data.WarmThroughputMiBps != null) requireBillingCommitment(context, 'WarmThroughputMiBps')
  const tags: Record<string, string> = Object.create(null)
  if (data.Tags) applyTags(tags, data.Tags, 'stream', name, context)
  const createTime = Date.now() - SEQ_ADJUST_MS
  const stream: StreamDoc = {
    RetentionPeriodHours: 24,
    EnhancedMonitoring: [{ ShardLevelMetrics: [] }],
    EncryptionType: 'NONE',
    HasMoreShards: false,
    Shards: [],
    StreamARN: streamArn(context, name),
    StreamName: name,
    StreamStatus: 'CREATING',
    StreamCreationTimestamp: Math.floor(createTime / 1000),
    StreamModeDetails: { StreamMode: mode },
    _seqIx: new Array(Math.ceil(shardCount / 5)).fill(null),
    _tags: tags,
  }
  if (data.MaxRecordSizeInKiB != null) stream.MaxRecordSizeInKiB = data.MaxRecordSizeInKiB
  if (data.RecordDistributionStrategy != null) stream.RecordDistributionStrategy = data.RecordDistributionStrategy
  if (data.WarmThroughputMiBps != null) stream.WarmThroughput = { TargetMiBps: data.WarmThroughputMiBps, CurrentMiBps: data.WarmThroughputMiBps }
  store.saveStream(stream)
  store.schedule('stream', name, 'activateStream', store.options.createStreamMs, uniformShards(shardCount, createTime))
}

export function deleteStream(context: Context, data: Input) {
  const name = streamNameOf(data)
  const { store } = context
  const stream = getStream(context, name)
  const consumers = [...store.consumers.values()].filter(consumer => consumer.StreamName === name)
  if (consumers.length && !data.EnforceConsumerDeletion) {
    throw resourceInUse(`Stream ${name} under account ${account(context)} has registered consumers. ` +
      'Deregister the consumers or set EnforceConsumerDeletion to true.')
  }
  const channels = [...store.channels.values()].filter(channel =>
    channel.ChannelStatus !== 'DELETING' && channel.StreamConfigurationList.some(entry => entry.StreamARN === stream.StreamARN))
  if (channels.length) {
    throw resourceInUse(`Stream ${name} under account ${account(context)} has channels attached. Delete the channels first.`)
  }
  stream.StreamStatus = 'DELETING'
  store.transaction(() => {
    store.saveStream(stream)
    store.deleteStreamRecords(name)
  })
  for (const consumer of consumers) {
    consumer.ConsumerStatus = 'DELETING'
    store.saveConsumer(consumer)
  }
  store.events.emit('stream-deleted', name)
  store.schedule('stream', name, 'deleteStream', store.options.deleteStreamMs)
}

function describeStreamView(stream: StreamDoc, shards: ShardDoc[], hasMoreShards: boolean) {
  const view: Record<string, unknown> = publicView(stream)
  view.Shards = shards
  view.HasMoreShards = hasMoreShards
  view.StreamModeDetails = stream.StreamModeDetails ?? { StreamMode: 'PROVISIONED' }
  return view
}

export function describeStream(context: Context, data: Input) {
  const stream = getStream(context, streamNameOf(data))
  let shards = stream.Shards
  if (data.ExclusiveStartShardId != null) shards = shards.filter(shard => shard.ShardId > data.ExclusiveStartShardId)
  const limit = (data.Limit as number | undefined) ?? 100
  return { StreamDescription: describeStreamView(stream, shards.slice(0, limit), shards.length > limit) }
}

export function describeStreamSummary(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = getStream(context, name)
  const { store } = context
  const view: Record<string, unknown> = publicView(stream)
  delete view.Shards
  delete view.HasMoreShards
  view.OpenShardCount = stream.Shards.filter(isOpen).length
  view.ConsumerCount = [...store.consumers.values()].filter(consumer => consumer.StreamName === name).length
  view.StreamModeDetails = stream.StreamModeDetails ?? { StreamMode: 'PROVISIONED' }
  const channelCount = [...store.channels.values()]
    .filter(channel => channel.StreamConfigurationList.some(entry => entry.StreamARN === stream.StreamARN)).length
  if (channelCount) view.ChannelCount = channelCount
  return { StreamDescriptionSummary: view }
}

export function listStreams(context: Context, data: Input) {
  const limit = (data.Limit as number | undefined) || 10
  let after = data.ExclusiveStartStreamName as string | undefined
  if (data.NextToken != null) after = decodeToken<{ after?: string }>(data.NextToken, 'ListStreams').after
  const names = [...context.store.streams.keys()].sort().filter(name => after === undefined || name > after)
  const page = names.slice(0, limit)
  const hasMore = names.length > limit
  const result: Record<string, unknown> = {
    StreamNames: page,
    HasMoreStreams: hasMore,
    StreamSummaries: page.map(name => {
      const stream = context.store.streams.get(name)!
      return {
        StreamName: stream.StreamName,
        StreamARN: stream.StreamARN,
        StreamStatus: stream.StreamStatus,
        StreamModeDetails: stream.StreamModeDetails ?? { StreamMode: 'PROVISIONED' },
        StreamCreationTimestamp: stream.StreamCreationTimestamp,
      }
    }),
  }
  if (hasMore) result.NextToken = encodeToken({ after: page[page.length - 1] })
  return result
}

export function registerStreamTransitions(store: Store) {
  store.registerTransition('activateStream', (current, name, shards) => {
    const stream = current.streams.get(name)
    if (!stream) return
    stream.StreamStatus = 'ACTIVE'
    stream.Shards = shards as ShardDoc[]
    current.saveStream(stream)
  })
  store.registerTransition('deleteStream', (current, name) => {
    const stream = current.streams.get(name)
    for (const consumer of [...current.consumers.values()]) {
      if (consumer.StreamName === name) current.removeConsumer(consumer.ConsumerARN)
    }
    if (stream) current.removePolicy(stream.StreamARN)
    current.removeStream(name)
  })
}
