import { invalidArgument, limitExceeded } from '../errors.ts'
import type { Store } from '../store/store.ts'
import type { StreamMode } from '../store/types.ts'
import {
  ON_DEMAND_STREAM_LIMIT, account, getStream, streamMode, streamNameOf, type Context, type Input,
} from './common.ts'
import { requireBillingCommitment } from './streams.ts'

function activeStream(context: Context, name: string) {
  const stream = getStream(context, name)
  if (stream.StreamStatus !== 'ACTIVE') {
    throw invalidArgument(`Stream ${name} under account ${account(context)} not ACTIVE, instead in state ${stream.StreamStatus}`)
  }
  return stream
}

export function updateStreamMode(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = activeStream(context, name)
  const mode = data.StreamModeDetails.StreamMode as StreamMode
  if (mode === 'ON_DEMAND' && streamMode(stream) !== 'ON_DEMAND') {
    const onDemand = [...context.store.streams.values()].filter(other => streamMode(other) === 'ON_DEMAND').length
    if (onDemand >= ON_DEMAND_STREAM_LIMIT) {
      throw limitExceeded(`This request would exceed the limit of ${ON_DEMAND_STREAM_LIMIT} ON_DEMAND streams for the account ${account(context)}.`)
    }
  }
  if (data.WarmThroughputMiBps != null) {
    if (mode !== 'ON_DEMAND') throw invalidArgument('WarmThroughputMiBps is supported only for streams in ON_DEMAND capacity mode.')
    requireBillingCommitment(context, 'WarmThroughputMiBps')
  }
  stream.StreamStatus = 'UPDATING'
  context.store.saveStream(stream)
  context.store.schedule('stream', name, 'updateStreamMode', context.store.options.updateStreamMs, {
    mode,
    warmThroughput: data.WarmThroughputMiBps ?? null,
  })
}

export function updateMaxRecordSize(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = activeStream(context, name)
  stream.MaxRecordSizeInKiB = data.MaxRecordSizeInKiB
  context.store.saveStream(stream)
}

export function updateStreamWarmThroughput(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = activeStream(context, name)
  if (streamMode(stream) !== 'ON_DEMAND') {
    throw invalidArgument(`UpdateStreamWarmThroughput is supported only for streams in ON_DEMAND capacity mode. Stream ${name} is PROVISIONED.`)
  }
  requireBillingCommitment(context, 'WarmThroughputMiBps')
  const target = data.WarmThroughputMiBps as number
  const current = stream.WarmThroughput?.CurrentMiBps ?? 0
  stream.WarmThroughput = { TargetMiBps: target, CurrentMiBps: current }
  stream.StreamStatus = 'UPDATING'
  context.store.saveStream(stream)
  context.store.schedule('stream', name, 'updateWarmThroughput', context.store.options.updateStreamMs, { target })
  return { StreamARN: stream.StreamARN, StreamName: name, WarmThroughput: { TargetMiBps: target, CurrentMiBps: current } }
}

export function updateStreamRecordDistributionStrategy(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = activeStream(context, name)
  if (streamMode(stream) !== 'ON_DEMAND') {
    throw invalidArgument(`UpdateStreamRecordDistributionStrategy is supported only for streams in ON_DEMAND capacity mode. Stream ${name} is PROVISIONED.`)
  }
  stream.RecordDistributionStrategy = data.RecordDistributionStrategy
  context.store.saveStream(stream)
}

export function registerCapacityTransitions(store: Store) {
  store.registerTransition('updateStreamMode', (current, name, data) => {
    const stream = current.streams.get(name)
    if (!stream) return
    const { mode, warmThroughput } = data as { mode: StreamMode, warmThroughput: number | null }
    stream.StreamModeDetails = { StreamMode: mode }
    if (mode === 'PROVISIONED') {
      delete stream.WarmThroughput
      delete stream.RecordDistributionStrategy
    } else if (warmThroughput !== null) {
      stream.WarmThroughput = { TargetMiBps: warmThroughput, CurrentMiBps: warmThroughput }
    }
    stream.StreamStatus = 'ACTIVE'
    current.saveStream(stream)
  })
  store.registerTransition('updateWarmThroughput', (current, name, data) => {
    const stream = current.streams.get(name)
    if (!stream) return
    const { target } = data as { target: number }
    stream.WarmThroughput = { TargetMiBps: target, CurrentMiBps: target }
    stream.StreamStatus = 'ACTIVE'
    current.saveStream(stream)
  })
}
