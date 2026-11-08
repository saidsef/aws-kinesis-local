import { invalidArgument, limitExceeded, resourceInUse, resourceNotFound } from '../errors.ts'
import type { Store } from '../store/store.ts'
import type { ConsumerDoc } from '../store/types.ts'
import {
  MAX_CONSUMERS_PER_STREAM, MAX_CREATING_CONSUMERS, account, applyTags, decodeToken, encodeToken, getStream, nowSeconds,
  streamNameOf, type Context, type Input,
} from './common.ts'

function consumerSummary(consumer: ConsumerDoc) {
  return {
    ConsumerName: consumer.ConsumerName,
    ConsumerARN: consumer.ConsumerARN,
    ConsumerStatus: consumer.ConsumerStatus,
    ConsumerCreationTimestamp: consumer.ConsumerCreationTimestamp,
  }
}

function streamConsumers(context: Context, streamName: string) {
  return [...context.store.consumers.values()]
    .filter(consumer => consumer.StreamName === streamName)
    .sort((a, b) => a.ConsumerCreationTimestamp - b.ConsumerCreationTimestamp || a.ConsumerName.localeCompare(b.ConsumerName))
}

export function consumerNotFound(context: Context, description: string) {
  return resourceNotFound(`Consumer ${description} under account ${account(context)} not found.`)
}

function findConsumer(context: Context, data: Input): ConsumerDoc {
  if (data.ConsumerARN != null) {
    const consumer = context.store.consumers.get(data.ConsumerARN)
    if (!consumer) throw consumerNotFound(context, data.ConsumerARN)
    return consumer
  }
  if (data.StreamARN == null || data.ConsumerName == null) {
    throw invalidArgument('Either ConsumerARN or both ConsumerName and StreamARN must be provided.')
  }
  const streamName = streamNameOf({ StreamARN: data.StreamARN })
  const consumer = streamConsumers(context, streamName).find(candidate => candidate.ConsumerName === data.ConsumerName)
  if (!consumer) throw consumerNotFound(context, `${data.ConsumerName} of stream ${streamName}`)
  return consumer
}

export function registerStreamConsumer(context: Context, data: Input) {
  const streamName = streamNameOf({ StreamARN: data.StreamARN })
  const stream = getStream(context, streamName)
  if (stream.StreamStatus === 'CREATING' || stream.StreamStatus === 'DELETING') {
    throw resourceInUse(`Stream ${streamName} under account ${account(context)} not ACTIVE, instead in state ${stream.StreamStatus}`)
  }
  const existing = streamConsumers(context, streamName)
  if (existing.some(consumer => consumer.ConsumerName === data.ConsumerName)) {
    throw resourceInUse(`Consumer ${data.ConsumerName} under stream ${streamName} already exists for account ${account(context)}.`)
  }
  if (existing.length >= MAX_CONSUMERS_PER_STREAM) {
    throw limitExceeded(`Stream ${streamName} under account ${account(context)} already has ${MAX_CONSUMERS_PER_STREAM} registered consumers.`)
  }
  const creating = [...context.store.consumers.values()].filter(consumer => consumer.ConsumerStatus === 'CREATING').length
  if (creating >= MAX_CREATING_CONSUMERS) {
    throw limitExceeded(`Account ${account(context)} already has ${MAX_CREATING_CONSUMERS} consumers in the CREATING state.`)
  }
  const created = nowSeconds()
  const consumer: ConsumerDoc = {
    ConsumerName: data.ConsumerName,
    ConsumerARN: `${stream.StreamARN}/consumer/${data.ConsumerName}:${created}`,
    ConsumerStatus: 'CREATING',
    ConsumerCreationTimestamp: created,
    StreamARN: stream.StreamARN,
    StreamName: streamName,
    _tags: Object.create(null),
  }
  if (data.Tags) applyTags(consumer._tags, data.Tags, 'consumer', data.ConsumerName, context)
  context.store.saveConsumer(consumer)
  context.store.schedule('consumer', consumer.ConsumerARN, 'activateConsumer', context.store.options.createStreamMs)
  return { Consumer: consumerSummary(consumer) }
}

export function describeStreamConsumer(context: Context, data: Input) {
  const consumer = findConsumer(context, data)
  return { ConsumerDescription: { ...consumerSummary(consumer), StreamARN: consumer.StreamARN } }
}

export function listStreamConsumers(context: Context, data: Input) {
  const streamName = streamNameOf({ StreamARN: data.StreamARN })
  getStream(context, streamName)
  let consumers = streamConsumers(context, streamName)
  if (data.NextToken != null) {
    const { after } = decodeToken<{ after: string }>(data.NextToken, 'ListStreamConsumers')
    const index = consumers.findIndex(consumer => consumer.ConsumerARN === after)
    consumers = consumers.slice(index + 1)
  }
  const limit = (data.MaxResults as number | undefined) ?? 100
  const page = consumers.slice(0, limit)
  const result: Record<string, unknown> = { Consumers: page.map(consumerSummary) }
  if (consumers.length > limit) result.NextToken = encodeToken({ after: page[page.length - 1]!.ConsumerARN })
  return result
}

export function deregisterStreamConsumer(context: Context, data: Input) {
  const consumer = findConsumer(context, data)
  if (consumer.ConsumerStatus === 'DELETING') return
  consumer.ConsumerStatus = 'DELETING'
  context.store.saveConsumer(consumer)
  context.store.events.emit('consumer-deleting', consumer.ConsumerARN)
  context.store.schedule('consumer', consumer.ConsumerARN, 'deleteConsumer', context.store.options.deleteStreamMs)
}

export function registerConsumerTransitions(store: Store) {
  store.registerTransition('activateConsumer', (current, arn) => {
    const consumer = current.consumers.get(arn)
    if (!consumer || consumer.ConsumerStatus !== 'CREATING') return
    consumer.ConsumerStatus = 'ACTIVE'
    current.saveConsumer(consumer)
  })
  store.registerTransition('deleteConsumer', (current, arn) => {
    current.removeConsumer(arn)
  })
}
