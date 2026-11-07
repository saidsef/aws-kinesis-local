import { randomUUID } from 'node:crypto'
import { invalidArgument, limitExceeded, resourceInUse, resourceNotFound } from '../errors.ts'
import type { Store } from '../store/store.ts'
import type { ChannelDoc } from '../store/types.ts'
import {
  CHANNEL_LIMIT, account, applyTags, decodeToken, encodeToken, getStream, nowSeconds, streamMode, streamNameFromArn,
  type Context, type Input,
} from './common.ts'

const DEFAULT_DATA_FRESHNESS_SECONDS = 300

function channelArn(context: Context, name: string) {
  return `arn:aws:kinesis:${context.store.options.region}:${account(context)}:channel/${name}`
}

function getChannel(context: Context, arn: string) {
  const channel = context.store.channels.get(arn)
  if (!channel) throw resourceNotFound(`Channel ${arn} under account ${account(context)} not found.`)
  return channel
}

function destinationType(channel: ChannelDoc) {
  return channel.S3TablesDestinationConfiguration ? 'S3_TABLES' : 'S3'
}

function streamCreationTimestamp(context: Context, arn: string) {
  const name = streamNameFromArn(arn)
  return name === undefined ? undefined : context.store.streams.get(name)?.StreamCreationTimestamp
}

function describe(context: Context, channel: ChannelDoc) {
  const description: Record<string, unknown> = {
    ChannelName: channel.ChannelName,
    ChannelARN: channel.ChannelARN,
    ChannelId: channel.ChannelId,
    ChannelStatus: channel.ChannelStatus,
    ChannelCreationTimestamp: channel.ChannelCreationTimestamp,
    ServiceExecutionRoleARN: channel.ServiceExecutionRoleARN,
    StreamConfigurationList: channel.StreamConfigurationList.map(entry => ({
      StreamARN: entry.StreamARN,
      StreamCreationTimestamp: streamCreationTimestamp(context, entry.StreamARN as string),
      RecordConfiguration: entry.RecordConfiguration,
    })),
    LoggingConfiguration: channel.LoggingConfiguration,
  }
  if (channel.S3DestinationConfiguration) description.S3DestinationConfiguration = channel.S3DestinationConfiguration
  if (channel.S3TablesDestinationConfiguration) description.S3TablesDestinationConfiguration = channel.S3TablesDestinationConfiguration
  if (channel.EncryptionConfiguration) description.EncryptionConfiguration = channel.EncryptionConfiguration
  return description
}

function withFreshness(destination: Input | undefined) {
  if (!destination) return undefined
  return { DataFreshnessInSeconds: DEFAULT_DATA_FRESHNESS_SECONDS, ...destination }
}

export function createChannel(context: Context, data: Input) {
  const { store } = context
  const arn = channelArn(context, data.ChannelName)
  if (store.channels.has(arn)) throw resourceInUse(`Channel ${data.ChannelName} under account ${account(context)} already exists.`)
  if (!data.S3DestinationConfiguration === !data.S3TablesDestinationConfiguration) {
    throw invalidArgument('Specify either S3DestinationConfiguration or S3TablesDestinationConfiguration, but not both.')
  }
  if (store.channels.size >= CHANNEL_LIMIT) {
    throw limitExceeded(`This request would exceed the limit of ${CHANNEL_LIMIT} channels for the account ${account(context)}.`)
  }
  const streamConfigurations = data.StreamConfigurationList as Input[]
  for (const entry of streamConfigurations) {
    const name = streamNameFromArn(entry.StreamARN)
    if (name === undefined) throw invalidArgument(`StreamARN ${entry.StreamARN} is not a valid stream ARN.`)
    const stream = getStream(context, name)
    if (streamMode(stream) !== 'ON_DEMAND') {
      throw invalidArgument(`Stream ${name} under account ${account(context)} must be in ON_DEMAND capacity mode to deliver through a channel.`)
    }
  }
  const tags: Record<string, string> = Object.create(null)
  if (data.Tags) applyTags(tags, data.Tags, 'channel', data.ChannelName, context)
  const channel: ChannelDoc = {
    ChannelName: data.ChannelName,
    ChannelARN: arn,
    ChannelId: randomUUID(),
    ChannelStatus: 'CREATING',
    ChannelCreationTimestamp: nowSeconds(),
    ServiceExecutionRoleARN: data.ServiceExecutionRoleARN,
    StreamConfigurationList: streamConfigurations.map(entry => ({ StreamARN: entry.StreamARN, RecordConfiguration: entry.RecordConfiguration })),
    LoggingConfiguration: data.LoggingConfiguration ?? { CloudWatchLogs: { Enabled: false } },
    _tags: tags,
  }
  const s3 = withFreshness(data.S3DestinationConfiguration)
  const s3Tables = withFreshness(data.S3TablesDestinationConfiguration)
  if (s3) channel.S3DestinationConfiguration = s3
  if (s3Tables) channel.S3TablesDestinationConfiguration = s3Tables
  if (data.EncryptionConfiguration) channel.EncryptionConfiguration = data.EncryptionConfiguration
  store.saveChannel(channel)
  store.schedule('channel', arn, 'activateChannel', store.options.createStreamMs)
  return { ChannelDescription: describe(context, channel) }
}

export function describeChannel(context: Context, data: Input) {
  return { ChannelDescription: describe(context, getChannel(context, data.ChannelARN)) }
}

export function listChannels(context: Context, data: Input) {
  const filters = (data.StreamFilter as Input[] | undefined) ?? []
  let channels = [...context.store.channels.values()].sort((a, b) => a.ChannelName.localeCompare(b.ChannelName))
  if (filters.length) {
    channels = channels.filter(channel => channel.StreamConfigurationList.some(entry => filters.some(filter =>
      filter.StreamARN === entry.StreamARN
      && (filter.StreamCreationTimestamp == null || filter.StreamCreationTimestamp === streamCreationTimestamp(context, entry.StreamARN as string)))))
  }
  if (data.NextToken != null) {
    const { after } = decodeToken<{ after: string }>(data.NextToken, 'ListChannels')
    channels = channels.filter(channel => channel.ChannelName > after)
  }
  const limit = (data.MaxResults as number | undefined) ?? 100
  const page = channels.slice(0, limit)
  const result: Record<string, unknown> = {
    ChannelSummaries: page.map(channel => ({
      ChannelName: channel.ChannelName,
      ChannelARN: channel.ChannelARN,
      ChannelId: channel.ChannelId,
      ChannelStatus: channel.ChannelStatus,
      ChannelCreationTimestamp: channel.ChannelCreationTimestamp,
      ChannelDestinationType: destinationType(channel),
      Streams: channel.StreamConfigurationList.map(entry => ({
        StreamARN: entry.StreamARN,
        StreamCreationTimestamp: streamCreationTimestamp(context, entry.StreamARN as string),
      })),
    })),
  }
  if (channels.length > limit) result.NextToken = encodeToken({ after: page[page.length - 1]!.ChannelName })
  return result
}

export function updateChannel(context: Context, data: Input) {
  const channel = getChannel(context, data.ChannelARN)
  if (channel.ChannelStatus !== 'ACTIVE') {
    throw resourceInUse(`Channel ${channel.ChannelName} under account ${account(context)} not ACTIVE, instead in state ${channel.ChannelStatus}`)
  }
  if (data.S3DestinationConfiguration && destinationType(channel) !== 'S3') {
    throw invalidArgument(`Channel ${channel.ChannelName} delivers to S3 Tables, so S3DestinationConfiguration cannot be updated.`)
  }
  if (data.S3TablesDestinationConfiguration && destinationType(channel) !== 'S3_TABLES') {
    throw invalidArgument(`Channel ${channel.ChannelName} delivers to S3, so S3TablesDestinationConfiguration cannot be updated.`)
  }
  if (data.S3DestinationConfiguration) {
    channel.S3DestinationConfiguration = { ...channel.S3DestinationConfiguration, ...data.S3DestinationConfiguration }
  }
  if (data.S3TablesDestinationConfiguration) {
    channel.S3TablesDestinationConfiguration = { ...channel.S3TablesDestinationConfiguration, ...data.S3TablesDestinationConfiguration }
  }
  if (data.LoggingConfiguration) channel.LoggingConfiguration = data.LoggingConfiguration
  channel.ChannelStatus = 'UPDATING'
  context.store.saveChannel(channel)
  context.store.schedule('channel', channel.ChannelARN, 'activateChannel', context.store.options.updateStreamMs)
  return { ChannelDescription: describe(context, channel) }
}

export function deleteChannel(context: Context, data: Input) {
  const channel = getChannel(context, data.ChannelARN)
  if (channel.ChannelStatus === 'DELETING') return
  channel.ChannelStatus = 'DELETING'
  context.store.saveChannel(channel)
  context.store.schedule('channel', channel.ChannelARN, 'deleteChannel', context.store.options.deleteStreamMs)
}

export function registerChannelTransitions(store: Store) {
  store.registerTransition('activateChannel', (current, arn) => {
    const channel = current.channels.get(arn)
    if (!channel) return
    channel.ChannelStatus = 'ACTIVE'
    current.saveChannel(channel)
  })
  store.registerTransition('deleteChannel', (current, arn) => {
    current.removeChannel(arn)
  })
}
