import { invalidArgument, resourceNotFound } from '../errors.ts'
import type { Protocol } from '../protocol/serialize.ts'
import type { Store } from '../store/store.ts'
import type { ShardDoc, StreamDoc } from '../store/types.ts'
import { parseSequence } from '../kinesis/sequence.ts'

export type Input = Record<string, any>

export interface Context {
  store: Store
  protocol: Protocol
}

export type Handler = (context: Context, data: Input) => unknown

export const DEFAULT_MAX_RECORD_SIZE_KIB = 1024
const MAX_TAGS_PER_RESOURCE = 50
export const MAX_RETENTION_HOURS = 8760
export const MIN_RETENTION_HOURS = 24
export const ON_DEMAND_SHARD_COUNT = 4
export const ON_DEMAND_STREAM_LIMIT = 50
export const MAX_CONSUMERS_PER_STREAM = 20
export const MAX_CREATING_CONSUMERS = 5
export const CHANNEL_LIMIT = 50

export function account(context: Context) {
  return context.store.options.accountId
}

export function streamArn(context: Context, name: string) {
  return `arn:aws:kinesis:${context.store.options.region}:${account(context)}:stream/${name}`
}

const STREAM_ARN = /^arn:aws[^:]*:kinesis:[^:]*:\d{12}:stream\/(\S+)$/
const CONSUMER_ARN = /^arn:aws[^:]*:kinesis:[^:]*:\d{12}:.*stream\/([a-zA-Z0-9_.-]+)\/consumer\/([a-zA-Z0-9_.-]+):(\d+)$/
const CHANNEL_ARN = /^arn:aws[^:]*:kinesis:[^:]*:\d{12}:channel\/(\S+)$/

export function streamNameFromArn(arn: string) {
  return STREAM_ARN.exec(arn)?.[1]
}

export function parseConsumerArn(arn: string) {
  const match = CONSUMER_ARN.exec(arn)
  return match ? { streamName: match[1]!, consumerName: match[2]! } : undefined
}

export function isChannelArn(arn: string) {
  return CHANNEL_ARN.test(arn)
}

export function streamNameOf(data: Input): string {
  const fromArn = typeof data.StreamARN === 'string' ? streamNameFromArn(data.StreamARN) : undefined
  if (data.StreamARN != null && fromArn === undefined) throw invalidArgument(`StreamARN ${data.StreamARN} is not a valid stream ARN.`)
  if (data.StreamName != null && fromArn !== undefined && data.StreamName !== fromArn) {
    throw invalidArgument(`StreamARN ${data.StreamARN} and StreamName ${data.StreamName} refer to different streams.`)
  }
  return (data.StreamName ?? fromArn) as string
}

function notFound(context: Context, name: string) {
  return resourceNotFound(`Stream ${name} under account ${account(context)} not found.`)
}

export function getStream(context: Context, name: string): StreamDoc {
  const stream = context.store.streams.get(name)
  if (!stream) throw notFound(context, name)
  return stream
}

export function isOpen(shard: ShardDoc) {
  return shard.SequenceNumberRange.EndingSequenceNumber == null
}

export function streamMode(stream: StreamDoc) {
  return stream.StreamModeDetails?.StreamMode ?? 'PROVISIONED'
}

export function provisionedOpenShards(context: Context) {
  let count = 0
  for (const stream of context.store.streams.values()) {
    if (streamMode(stream) === 'PROVISIONED') count += stream.Shards.filter(isOpen).length
  }
  return count
}

export function shardLimitMessage(context: Context, current: number, additional: number) {
  const { region, shardLimit } = context.store.options
  return `This request would exceed the shard limit for the account ${account(context)} in ${region}. ` +
    `Current shard count for the account: ${current}. Limit: ${shardLimit}. ` +
    `Number of additional shards that would have resulted from this request: ${additional}. ` +
    'Refer to the AWS Service Limits page (http://docs.aws.amazon.com/general/latest/gr/aws_service_limits.html) ' +
    'for current limits and how to request higher limits.'
}

export function shardCreateTime(shard: ShardDoc) {
  return parseSequence(shard.SequenceNumberRange.StartingSequenceNumber).shardCreateTime
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

const INVALID_TAG_CHARACTERS = /[^À-῿Ⰰ-퟿\w./\-=+_ @%]/

function checkTagCharacters(values: string[], action: string, resource: string, context: Context) {
  if (values.some(value => INVALID_TAG_CHARACTERS.test(value))) {
    throw invalidArgument('Some tags contain invalid characters. Valid characters: Unicode letters, digits, white space, _ . / = + - % @.')
  }
  if (values.some(value => value.includes('%'))) {
    throw invalidArgument(`Failed to ${action} ${resource} under account ${account(context)} because some tags contained illegal characters. ` +
      'The allowed characters are Unicode letters, white-spaces, \'_\',\',\',\'/\',\'=\',\'+\',\'-\',\'@\'.')
  }
}

export function applyTags(existing: Record<string, string>, tags: Record<string, string>, kind: string, name: string, context: Context) {
  const keys = Object.keys(tags)
  checkTagCharacters([...keys, ...Object.values(tags)], 'add tags to', `${kind} ${name}`, context)
  const total = new Set([...keys, ...Object.keys(existing)]).size
  if (total > MAX_TAGS_PER_RESOURCE) {
    throw invalidArgument(`Failed to add tags to ${kind} ${name} under account ${account(context)} ` +
      `because a given ${kind} cannot have more than ${MAX_TAGS_PER_RESOURCE} tags associated with it.`)
  }
  for (const key of keys) existing[key] = tags[key]!
}

export function removeTags(existing: Record<string, string>, keys: string[], kind: string, name: string, context: Context) {
  checkTagCharacters(keys, 'remove tags from', `${kind} ${name}`, context)
  for (const key of keys) delete existing[key]
}

export function tagList(tags: Record<string, string>) {
  return Object.keys(tags).sort().map(key => ({ Key: key, Value: tags[key]! }))
}

export function encodeToken(value: unknown) {
  return Buffer.from(JSON.stringify({ ...value as object, t: Date.now() }), 'utf8').toString('base64')
}

export function decodeToken<T>(token: string, operation: string): T {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
  } catch {
    value = undefined
  }
  if (value && typeof value === 'object') return value as T
  throw invalidArgument(`Invalid NextToken for ${operation}.`)
}

export function publicView<T extends object>(doc: T): Partial<T> {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !key.startsWith('_'))) as Partial<T>
}
