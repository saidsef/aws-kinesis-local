import { invalidArgument } from '../errors.ts'
import { MAX_RETENTION_HOURS, MIN_RETENTION_HOURS, getStream, streamNameOf, type Context, type Input } from './common.ts'

function checkBounds(hours: number) {
  if (hours < MIN_RETENTION_HOURS) {
    throw invalidArgument(`Minimum allowed retention period is ${MIN_RETENTION_HOURS} hours. Requested retention period (${hours} hours) is too short.`)
  }
  if (hours > MAX_RETENTION_HOURS) {
    throw invalidArgument(`Maximum allowed retention period is ${MAX_RETENTION_HOURS} hours. Requested retention period (${hours} hours) is too long.`)
  }
}

export function increaseStreamRetentionPeriod(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = getStream(context, name)
  const hours = data.RetentionPeriodHours as number
  checkBounds(hours)
  if (stream.RetentionPeriodHours > hours) {
    throw invalidArgument(`Requested retention period (${hours} hours) for stream ${name} can not be shorter than ` +
      `existing retention period (${stream.RetentionPeriodHours} hours). Use DecreaseRetentionPeriod API.`)
  }
  stream.RetentionPeriodHours = hours
  context.store.saveStream(stream)
}

export function decreaseStreamRetentionPeriod(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = getStream(context, name)
  const hours = data.RetentionPeriodHours as number
  checkBounds(hours)
  if (stream.RetentionPeriodHours < hours) {
    throw invalidArgument(`Requested retention period (${hours} hours) for stream ${name} can not be longer than ` +
      `existing retention period (${stream.RetentionPeriodHours} hours). Use IncreaseRetentionPeriod API.`)
  }
  stream.RetentionPeriodHours = hours
  context.store.saveStream(stream)
}
