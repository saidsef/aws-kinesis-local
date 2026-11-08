import { invalidArgument, limitExceeded, resourceInUse, resourceNotFound } from '../errors.ts'
import { MAX_SEQUENCE_INDEX, POW_2_128, parseSequence, resolveShardId, shardIdName, stringifySequence } from '../kinesis/sequence.ts'
import type { Store } from '../store/store.ts'
import type { ShardDoc, StreamDoc } from '../store/types.ts'
import {
  account, decodeToken, encodeToken, getStream, isOpen, provisionedOpenShards, shardCreateTime, shardLimitMessage,
  streamMode, streamNameOf, type Context, type Input,
} from './common.ts'

const MAX_SHARDS_PER_STREAM = 10000
const DEFAULT_LIST_SHARDS_LIMIT = 1000

interface ShardFilter {
  Type: string
  ShardId?: string
  Timestamp?: number
}

function shardEndTime(shard: ShardDoc) {
  const end = shard.SequenceNumberRange.EndingSequenceNumber
  return end ? parseSequence(end).seqTime : Infinity
}

function filterShards(stream: StreamDoc, filter: ShardFilter) {
  const now = Date.now()
  const shards = stream.Shards
  const earliest = Math.min(...shards.map(shardCreateTime))
  const trimHorizon = Math.max(now - stream.RetentionPeriodHours * 3600 * 1000, earliest)
  const activeAt = (time: number) => shards.filter(shard => shardCreateTime(shard) <= time && shardEndTime(shard) >= time)
  switch (filter.Type) {
    case 'AFTER_SHARD_ID':
      if (filter.ShardId == null) throw invalidArgument('ShardId must be specified when ShardFilter type is AFTER_SHARD_ID.')
      return shards.filter(shard => shard.ShardId > filter.ShardId!)
    case 'AT_TRIM_HORIZON':
      return activeAt(trimHorizon)
    case 'FROM_TRIM_HORIZON':
      return shards.filter(shard => shardEndTime(shard) >= trimHorizon)
    case 'AT_LATEST':
      return shards.filter(isOpen)
    case 'AT_TIMESTAMP':
    case 'FROM_TIMESTAMP': {
      if (filter.Timestamp == null) throw invalidArgument(`Timestamp must be specified when ShardFilter type is ${filter.Type}.`)
      const time = Math.max(filter.Timestamp * 1000, trimHorizon)
      return filter.Type === 'AT_TIMESTAMP'
        ? shards.filter(shard => shardCreateTime(shard) <= Math.max(time, earliest) && shardEndTime(shard) >= time)
        : shards.filter(shard => shardEndTime(shard) >= time)
    }
    default:
      throw invalidArgument(`Unsupported ShardFilter type ${filter.Type}.`)
  }
}

export function listShards(context: Context, data: Input) {
  const namesStream = data.StreamName != null || data.StreamARN != null
  if (!namesStream && data.NextToken == null) throw invalidArgument('Either NextToken or StreamName should be provided.')
  if (namesStream && data.NextToken != null) throw invalidArgument('NextToken and StreamName cannot be provided together.')
  let name: string
  let after = data.ExclusiveStartShardId as string | undefined
  let filter = data.ShardFilter as ShardFilter | undefined
  if (data.NextToken != null) {
    if (after != null) throw invalidArgument('NextToken and ExclusiveStartShardId cannot be provided together.')
    const token = decodeToken<{ stream: string, after?: string, filter?: ShardFilter }>(data.NextToken, 'ListShards')
    name = token.stream
    after = token.after
    filter = token.filter
  } else {
    name = streamNameOf(data)
  }
  const stream = getStream(context, name)
  let shards = filter ? filterShards(stream, filter) : stream.Shards
  if (after != null) shards = shards.filter(shard => shard.ShardId > after)
  const limit = (data.MaxResults as number | undefined) ?? DEFAULT_LIST_SHARDS_LIMIT
  const page = shards.slice(0, limit)
  const result: Record<string, unknown> = { Shards: page }
  if (shards.length > limit) result.NextToken = encodeToken({ stream: name, after: page[page.length - 1]!.ShardId, filter })
  return result
}

function notActive(context: Context, name: string, stream: StreamDoc) {
  return resourceInUse(`Stream ${name} under account ${account(context)} not ACTIVE, instead in state ${stream.StreamStatus}`)
}

function missingShard(context: Context, name: string, shardId: string) {
  return resourceNotFound(`Could not find shard ${shardId} in stream ${name} under account ${account(context)}.`)
}

function closedShard(context: Context, name: string, shardId: string, purpose: string) {
  return invalidArgument(`Shard ${shardId} in stream ${name} under account ${account(context)} has already been merged or split, ` +
    `and thus is not eligible for ${purpose}.`)
}

function closeShard(shard: ShardDoc, shardIx: number, now: number) {
  shard.SequenceNumberRange.EndingSequenceNumber = stringifySequence({
    shardCreateTime: shardCreateTime(shard),
    shardIx,
    seqIx: MAX_SEQUENCE_INDEX,
    seqTime: now,
  })
}

function newShardSequence(stream: StreamDoc, now: number) {
  return stringifySequence({ shardCreateTime: now + 1000, shardIx: stream.Shards.length })
}

function applySplit(stream: StreamDoc, shardIx: number, hashKey: bigint, now: number) {
  const shard = stream.Shards[shardIx]!
  closeShard(shard, shardIx, now)
  stream.Shards.push({
    ParentShardId: shard.ShardId,
    HashKeyRange: { StartingHashKey: shard.HashKeyRange.StartingHashKey, EndingHashKey: (hashKey - 1n).toString() },
    SequenceNumberRange: { StartingSequenceNumber: newShardSequence(stream, now) },
    ShardId: shardIdName(stream.Shards.length),
  })
  stream.Shards.push({
    ParentShardId: shard.ShardId,
    HashKeyRange: { StartingHashKey: hashKey.toString(), EndingHashKey: shard.HashKeyRange.EndingHashKey },
    SequenceNumberRange: { StartingSequenceNumber: newShardSequence(stream, now) },
    ShardId: shardIdName(stream.Shards.length),
  })
}

function applyMerge(stream: StreamDoc, shardIx: number, adjacentShardIx: number, now: number) {
  const shard = stream.Shards[shardIx]!
  const adjacent = stream.Shards[adjacentShardIx]!
  closeShard(shard, shardIx, now)
  closeShard(adjacent, adjacentShardIx, now)
  stream.Shards.push({
    ParentShardId: shard.ShardId,
    AdjacentParentShardId: adjacent.ShardId,
    HashKeyRange: { StartingHashKey: shard.HashKeyRange.StartingHashKey, EndingHashKey: adjacent.HashKeyRange.EndingHashKey },
    SequenceNumberRange: { StartingSequenceNumber: newShardSequence(stream, now) },
    ShardId: shardIdName(stream.Shards.length),
  })
}

export function splitShard(context: Context, data: Input) {
  const name = streamNameOf(data)
  const target = resolveShardId(data.ShardToSplit)
  if (!target) throw missingShard(context, name, data.ShardToSplit)
  const stream = getStream(context, name)
  if (stream.StreamStatus !== 'ACTIVE') throw notActive(context, name, stream)
  if (target.shardIx >= stream.Shards.length) throw missingShard(context, name, target.shardId)
  const shard = stream.Shards[target.shardIx]!
  if (!isOpen(shard)) throw closedShard(context, name, target.shardId, 'splitting')
  const shardSum = provisionedOpenShards(context)
  if (streamMode(stream) === 'PROVISIONED' && shardSum + 1 > context.store.options.shardLimit) {
    throw limitExceeded(shardLimitMessage(context, shardSum, 1))
  }
  const hashKey = BigInt(data.NewStartingHashKey)
  if (hashKey <= BigInt(shard.HashKeyRange.StartingHashKey) + 1n || hashKey >= BigInt(shard.HashKeyRange.EndingHashKey)) {
    throw invalidArgument(`NewStartingHashKey ${data.NewStartingHashKey} used in SplitShard() on shard ${target.shardId} ` +
      `in stream ${name} under account ${account(context)} is not both greater than one plus the shard's StartingHashKey ` +
      `${shard.HashKeyRange.StartingHashKey} and less than the shard's EndingHashKey ${shard.HashKeyRange.EndingHashKey}.`)
  }
  stream.StreamStatus = 'UPDATING'
  context.store.saveStream(stream)
  context.store.schedule('stream', name, 'splitShard', context.store.options.updateStreamMs, { shardIx: target.shardIx, hashKey: hashKey.toString() })
}

export function mergeShards(context: Context, data: Input) {
  const name = streamNameOf(data)
  const requested = [data.ShardToMerge as string, data.AdjacentShardToMerge as string]
  const targets = requested.map(shardId => {
    const target = resolveShardId(shardId)
    if (!target) throw missingShard(context, name, shardId)
    return target
  })
  const stream = getStream(context, name)
  if (stream.StreamStatus !== 'ACTIVE') throw notActive(context, name, stream)
  for (const target of targets) {
    if (target.shardIx >= stream.Shards.length) throw missingShard(context, name, target.shardId)
  }
  const [first, second] = targets as [typeof targets[number], typeof targets[number]]
  const shards = [stream.Shards[first.shardIx]!, stream.Shards[second.shardIx]!]
  for (let i = 0; i < 2; i++) {
    if (!isOpen(shards[i]!)) throw closedShard(context, name, targets[i]!.shardId, 'merging')
  }
  if (BigInt(shards[0]!.HashKeyRange.EndingHashKey) + 1n !== BigInt(shards[1]!.HashKeyRange.StartingHashKey)) {
    throw invalidArgument(`Shards ${first.shardId} and ${second.shardId} in stream ${name} under account ${account(context)} ` +
      'are not an adjacent pair of shards eligible for merging')
  }
  stream.StreamStatus = 'UPDATING'
  context.store.saveStream(stream)
  context.store.schedule('stream', name, 'mergeShards', context.store.options.updateStreamMs, { shardIxs: [first.shardIx, second.shardIx] })
}

function reshard(stream: StreamDoc, target: number, now: number) {
  const width = POW_2_128 / BigInt(target)
  const starts = Array.from({ length: target }, (_, i) => width * BigInt(i))
  for (const boundary of starts.slice(1)) {
    const shardIx = stream.Shards.findIndex(shard =>
      isOpen(shard) && BigInt(shard.HashKeyRange.StartingHashKey) < boundary && boundary <= BigInt(shard.HashKeyRange.EndingHashKey))
    if (shardIx >= 0) applySplit(stream, shardIx, boundary, now)
  }
  for (let i = 0; i < target; i++) {
    const low = starts[i]!
    const high = i === target - 1 ? POW_2_128 - 1n : starts[i + 1]! - 1n
    for (;;) {
      const inside = stream.Shards
        .map((shard, shardIx) => ({ shard, shardIx }))
        .filter(({ shard }) => isOpen(shard) && BigInt(shard.HashKeyRange.StartingHashKey) >= low && BigInt(shard.HashKeyRange.EndingHashKey) <= high)
        .sort((a, b) => (BigInt(a.shard.HashKeyRange.StartingHashKey) < BigInt(b.shard.HashKeyRange.StartingHashKey) ? -1 : 1))
      if (inside.length < 2) break
      applyMerge(stream, inside[0]!.shardIx, inside[1]!.shardIx, now)
    }
  }
}

export function updateShardCount(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = getStream(context, name)
  if (streamMode(stream) === 'ON_DEMAND') {
    throw invalidArgument(`UpdateShardCount is not supported for stream ${name} under account ${account(context)} because it is in ON_DEMAND capacity mode.`)
  }
  if (stream.StreamStatus !== 'ACTIVE') throw notActive(context, name, stream)
  const current = stream.Shards.filter(isOpen).length
  const target = data.TargetShardCount as number
  if (target > current * 2) {
    throw limitExceeded(`UpdateShardCount cannot scale up over double your current open shard count. Current open shard count: ${current} Target shard count: ${target}`)
  }
  if (target * 2 < current) {
    throw limitExceeded(`UpdateShardCount cannot scale down below half your current open shard count. Current open shard count: ${current} Target shard count: ${target}`)
  }
  if (target > MAX_SHARDS_PER_STREAM) {
    throw limitExceeded(`UpdateShardCount cannot scale up to more than ${MAX_SHARDS_PER_STREAM} shards in a stream. Target shard count: ${target}`)
  }
  const shardSum = provisionedOpenShards(context)
  if (target > current && shardSum - current + target > context.store.options.shardLimit) {
    throw limitExceeded(shardLimitMessage(context, shardSum, target - current))
  }
  stream.StreamStatus = 'UPDATING'
  context.store.saveStream(stream)
  context.store.schedule('stream', name, 'updateShardCount', context.store.options.updateStreamMs, { target })
  return { StreamName: name, CurrentShardCount: current, TargetShardCount: target, StreamARN: stream.StreamARN }
}

function finishResharding(store: Store, stream: StreamDoc, closed: number[]) {
  stream.StreamStatus = 'ACTIVE'
  store.saveStream(stream)
  for (const shardIx of closed) store.events.emit('records', stream.StreamName, shardIx)
}

export function registerShardTransitions(store: Store) {
  store.registerTransition('splitShard', (current, name, data) => {
    const stream = current.streams.get(name)
    if (!stream) return
    const { shardIx, hashKey } = data as { shardIx: number, hashKey: string }
    applySplit(stream, shardIx, BigInt(hashKey), Date.now())
    finishResharding(current, stream, [shardIx])
  })
  store.registerTransition('mergeShards', (current, name, data) => {
    const stream = current.streams.get(name)
    if (!stream) return
    const { shardIxs } = data as { shardIxs: [number, number] }
    applyMerge(stream, shardIxs[0], shardIxs[1], Date.now())
    finishResharding(current, stream, shardIxs)
  })
  store.registerTransition('updateShardCount', (current, name, data) => {
    const stream = current.streams.get(name)
    if (!stream) return
    const open = stream.Shards.map((shard, shardIx) => (isOpen(shard) ? shardIx : -1)).filter(shardIx => shardIx >= 0)
    const { target } = data as { target: number }
    if (open.length !== target) reshard(stream, target, Date.now())
    finishResharding(current, stream, open)
  })
}
