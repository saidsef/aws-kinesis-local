import { invalidArgument, resourceNotFound } from '../errors.ts'
import {
  account, applyTags, getStream, isChannelArn, parseConsumerArn, removeTags, streamNameFromArn, streamNameOf, tagList,
  type Context, type Input,
} from './common.ts'

export function addTagsToStream(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = getStream(context, name)
  applyTags(stream._tags, data.Tags, 'stream', name, context)
  context.store.saveStream(stream)
}

export function removeTagsFromStream(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = getStream(context, name)
  removeTags(stream._tags, data.TagKeys, 'stream', name, context)
  context.store.saveStream(stream)
}

export function listTagsForStream(context: Context, data: Input) {
  const stream = getStream(context, streamNameOf(data))
  const limit = (data.Limit as number | undefined) || 100
  let keys = Object.keys(stream._tags).sort()
  if (data.ExclusiveStartTagKey) keys = keys.filter(key => key > data.ExclusiveStartTagKey)
  return {
    Tags: keys.slice(0, limit).map(key => ({ Key: key, Value: stream._tags[key]! })),
    HasMoreTags: keys.length > limit,
  }
}

function resourceOf(context: Context, arn: string) {
  const { store } = context
  const consumer = parseConsumerArn(arn)
  if (consumer) {
    const doc = store.consumers.get(arn)
    if (!doc) throw resourceNotFound(`Consumer ${arn} under account ${account(context)} not found.`)
    return { kind: 'consumer', name: consumer.consumerName, tags: doc._tags, save: () => store.saveConsumer(doc) }
  }
  if (isChannelArn(arn)) {
    const doc = store.channels.get(arn)
    if (!doc) throw resourceNotFound(`Channel ${arn} under account ${account(context)} not found.`)
    return { kind: 'channel', name: doc.ChannelName, tags: doc._tags, save: () => store.saveChannel(doc) }
  }
  const streamName = streamNameFromArn(arn)
  if (streamName === undefined) throw invalidArgument(`ResourceARN ${arn} is not a valid Kinesis resource ARN.`)
  const stream = getStream(context, streamName)
  return { kind: 'stream', name: streamName, tags: stream._tags, save: () => store.saveStream(stream) }
}

export function tagResource(context: Context, data: Input) {
  const resource = resourceOf(context, data.ResourceARN)
  applyTags(resource.tags, data.Tags, resource.kind, resource.name, context)
  resource.save()
}

export function untagResource(context: Context, data: Input) {
  const resource = resourceOf(context, data.ResourceARN)
  removeTags(resource.tags, data.TagKeys, resource.kind, resource.name, context)
  resource.save()
}

export function listTagsForResource(context: Context, data: Input) {
  return { Tags: tagList(resourceOf(context, data.ResourceARN).tags) }
}
