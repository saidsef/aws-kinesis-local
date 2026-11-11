import { KinesisError, resourceInUse, resourceNotFound } from '../errors.ts'
import { parseSequence, resolveShardId, stringifySequence, type ParsedSequence } from '../kinesis/sequence.ts'
import { encodeEvent } from '../protocol/eventstream.ts'
import { AMZ_CBOR, encodeBody, serializeShape, type Protocol } from '../protocol/serialize.ts'
import type { Store } from '../store/store.ts'
import { account, getStream, type Context, type Input } from './common.ts'
import { consumerNotFound } from './consumers.ts'
import { childShards, dryRun, readShard, startingSequence } from './records.ts'

const SUBSCRIPTION_MS = 300000
const RESUBSCRIBE_WINDOW_MS = 5000
const HEARTBEAT_MS = 5000
const POLL_MS = 1000
const EVENT_RECORD_LIMIT = 1000

export interface EventSink {
  write(chunk: Buffer): void
  end(): void
  onClose(listener: () => void): void
}

interface SubscriptionState {
  lastSubscribed: Map<string, number>
  active: Map<string, Subscription>
}

const states = new WeakMap<Store, SubscriptionState>()

function stateOf(store: Store) {
  let state = states.get(store)
  if (!state) {
    const lastSubscribed = new Map<string, number>()
    store.events.on('consumer-removed', (arn: string) => {
      for (const key of lastSubscribed.keys()) if (key.startsWith(`${arn}|`)) lastSubscribed.delete(key)
    })
    state = { lastSubscribed, active: new Map() }
    states.set(store, state)
  }
  return state
}

function previousTime(position: ParsedSequence) {
  return stringifySequence({
    shardCreateTime: position.shardCreateTime,
    shardIx: position.shardIx,
    seqIx: position.seqIx ?? null,
    seqTime: position.seqTime - 1000,
  })
}

export class Subscription {
  readonly context: Context
  readonly key: string
  readonly consumerArn: string
  readonly streamName: string
  readonly shardIx: number
  readonly shardId: string
  private position: string
  private continuation: string
  private sink: EventSink | undefined
  private finished = false
  private timer: NodeJS.Timeout | undefined
  private deadline: NodeJS.Timeout | undefined
  private lastEventAt = 0
  private readonly onRecords: (name: string, shardIx: number) => void
  private readonly onConsumerGone: (arn: string) => void
  private readonly onStreamDeleted: (name: string) => void
  private readonly onDrain: () => void

  constructor(context: Context, consumerArn: string, streamName: string, shardIx: number, shardId: string, position: string) {
    this.context = context
    this.key = `${consumerArn}|${shardId}`
    this.consumerArn = consumerArn
    this.streamName = streamName
    this.shardIx = shardIx
    this.shardId = shardId
    this.position = position
    this.continuation = previousTime(parseSequence(position))
    this.onRecords = (name, changed) => {
      if (name === this.streamName && changed === this.shardIx) this.schedule(0)
    }
    this.onConsumerGone = arn => {
      if (arn === this.consumerArn) this.fail(consumerNotFound(this.context, arn))
    }
    this.onStreamDeleted = name => {
      if (name === this.streamName) this.fail(resourceNotFound(`Stream ${name} under account ${account(this.context)} not found.`))
    }
    this.onDrain = () => this.stop()
  }

  get protocol(): Protocol {
    return this.context.protocol
  }

  get payloadType() {
    return this.protocol === 'cbor' ? AMZ_CBOR : 'application/json'
  }

  start(sink: EventSink) {
    this.sink = sink
    const events = this.context.store.events
    events.on('records', this.onRecords)
    events.on('consumer-deleting', this.onConsumerGone)
    events.on('consumer-removed', this.onConsumerGone)
    events.on('stream-deleted', this.onStreamDeleted)
    events.on('drain', this.onDrain)
    sink.onClose(() => this.stop())
    sink.write(encodeEvent({ ':event-type': 'initial-response', ':content-type': this.payloadType, ':message-type': 'event' }, encodeBody({}, this.protocol)))
    if (this.context.store.draining) return this.stop()
    this.deadline = setTimeout(() => this.stop(), SUBSCRIPTION_MS)
    this.schedule(0)
  }

  private schedule(delay: number) {
    if (this.finished) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.deliver(), delay)
  }

  private deliver() {
    if (this.finished || !this.sink) return
    const stream = this.context.store.streams.get(this.streamName)
    if (!stream) {
      this.fail(resourceNotFound(`Stream ${this.streamName} under account ${account(this.context)} not found.`))
      return
    }
    let result
    try {
      result = readShard(this.context, stream, this.shardIx, parseSequence(this.position), this.position, EVENT_RECORD_LIMIT)
    } catch (error) {
      this.fail(error instanceof KinesisError ? error : new KinesisError('InternalFailureException', String(error), 500))
      return
    }
    const now = Date.now()
    const event: Record<string, unknown> = { Records: result.records, MillisBehindLatest: result.millisBehindLatest }
    if (result.records.length) this.continuation = result.records[result.records.length - 1]!.SequenceNumber as string
    this.position = result.nextSequence
    if (result.shardEnded) {
      event.ChildShards = childShards(stream, this.shardId)
      this.send(event)
      this.stop()
      return
    }
    event.ContinuationSequenceNumber = this.continuation
    if (result.records.length || now - this.lastEventAt >= HEARTBEAT_MS) this.send(event)
    this.schedule(result.records.length === EVENT_RECORD_LIMIT ? 0 : POLL_MS)
  }

  private send(event: Record<string, unknown>) {
    this.lastEventAt = Date.now()
    const ordered = {
      Records: event.Records,
      ContinuationSequenceNumber: event.ContinuationSequenceNumber,
      MillisBehindLatest: event.MillisBehindLatest,
      ChildShards: event.ChildShards,
    }
    const payload = encodeBody(serializeShape(ordered, 'SubscribeToShardEvent', this.protocol), this.protocol)
    this.sink!.write(encodeEvent({ ':event-type': 'SubscribeToShardEvent', ':content-type': this.payloadType, ':message-type': 'event' }, payload))
  }

  fail(error: KinesisError) {
    if (this.finished || !this.sink) return
    this.sink.write(encodeEvent(
      { ':exception-type': error.type, ':content-type': this.payloadType, ':message-type': 'exception' },
      encodeBody({ message: error.message }, this.protocol),
    ))
    this.stop()
  }

  stop() {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timer)
    clearTimeout(this.deadline)
    const events = this.context.store.events
    events.off('records', this.onRecords)
    events.off('consumer-deleting', this.onConsumerGone)
    events.off('consumer-removed', this.onConsumerGone)
    events.off('stream-deleted', this.onStreamDeleted)
    events.off('drain', this.onDrain)
    const { active } = stateOf(this.context.store)
    if (active.get(this.key) === this) active.delete(this.key)
    this.sink?.end()
  }
}

export function subscribeToShard(context: Context, data: Input) {
  const consumer = context.store.consumers.get(data.ConsumerARN)
  if (!consumer) throw consumerNotFound(context, data.ConsumerARN)
  if (consumer.ConsumerStatus !== 'ACTIVE') {
    throw resourceInUse(`Consumer ${data.ConsumerARN} under account ${account(context)} is not ACTIVE, instead in state ${consumer.ConsumerStatus}`)
  }
  const stream = getStream(context, consumer.StreamName)
  const shard = resolveShardId(data.ShardId)
  if (!shard || shard.shardIx >= stream.Shards.length) {
    throw resourceNotFound(`Could not find shard ${data.ShardId} in stream ${consumer.StreamName} under account ${account(context)}.`)
  }
  const position = startingSequence(context, stream, shard.shardIx, shard.shardId, data.StartingPosition, 'SubscribeToShard')
  const key = `${consumer.ConsumerARN}|${shard.shardId}`
  const { lastSubscribed, active } = stateOf(context.store)
  const now = Date.now()
  const previous = lastSubscribed.get(key)
  if (previous !== undefined && now - previous < RESUBSCRIBE_WINDOW_MS) {
    throw resourceInUse(`Another active subscription exists for consumer ${consumer.ConsumerARN} on shard ${shard.shardId}. ` +
      `Wait ${RESUBSCRIBE_WINDOW_MS / 1000} seconds after a successful SubscribeToShard call before calling it again.`)
  }
  dryRun(data)
  lastSubscribed.set(key, now)
  active.get(key)?.fail(resourceInUse(`Subscription for consumer ${consumer.ConsumerARN} on shard ${shard.shardId} was taken over by a newer SubscribeToShard call.`))
  const subscription = new Subscription(context, consumer.ConsumerARN, consumer.StreamName, shard.shardIx, shard.shardId, position)
  active.set(key, subscription)
  return subscription
}

