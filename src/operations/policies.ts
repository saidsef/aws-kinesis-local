import { invalidArgument, resourceNotFound } from '../errors.ts'
import { account, getStream, isChannelArn, parseConsumerArn, streamNameFromArn, type Context, type Input } from './common.ts'

function canonicalArn(context: Context, arn: string) {
  if (parseConsumerArn(arn)) {
    if (!context.store.consumers.has(arn)) throw resourceNotFound(`Consumer ${arn} under account ${account(context)} not found.`)
    return arn
  }
  if (isChannelArn(arn)) {
    if (!context.store.channels.has(arn)) throw resourceNotFound(`Channel ${arn} under account ${account(context)} not found.`)
    return arn
  }
  const name = streamNameFromArn(arn)
  if (name === undefined) throw invalidArgument(`ResourceARN ${arn} is not a valid Kinesis resource ARN.`)
  return getStream(context, name).StreamARN
}

export function putResourcePolicy(context: Context, data: Input) {
  const arn = canonicalArn(context, data.ResourceARN)
  let policy: unknown
  try {
    policy = JSON.parse(data.Policy)
  } catch {
    policy = undefined
  }
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw invalidArgument('Policy must be a valid JSON policy document.')
  }
  context.store.savePolicy(arn, data.Policy)
}

export function getResourcePolicy(context: Context, data: Input) {
  return { Policy: context.store.policies.get(canonicalArn(context, data.ResourceARN)) ?? '{}' }
}

export function deleteResourcePolicy(context: Context, data: Input) {
  context.store.removePolicy(canonicalArn(context, data.ResourceARN))
}
