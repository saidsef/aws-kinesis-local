import { randomBytes } from 'node:crypto'
import { KinesisError, clientError, invalidArgument, resourceNotFound, serverError } from '../errors.ts'
import { ITERATOR_TTL_MS, createShardIterator, readShardIterator } from '../kinesis/iterator.ts'
import {
  POW_2_128, incrementSequence, parseSequence, partitionKeyToHashKey, resolveShardId, shardIdName, stringifySequence,
  type ParsedSequence,
} from '../kinesis/sequence.ts'
import type { NewRecord, ShardDoc, StreamDoc } from '../store/types.ts'
import { account, getStream, isOpen, shardCreateTime, streamNameOf, type Context, type Input } from './common.ts'

const SHARD_ORDER_SMALL = [15, 16, 14, 13, 10, 12, 11, 7, 5, 9, 8, 6, 4, 3, 2, 1, 0]
const SHARD_ORDER_MEDIUM = [25, 21, 23, 22, 24, 20, 15, 19, 16, 17, 18, 11, 14, 13, 10, 12, 9, 6, 7, 5, 8, 3, 0, 4, 2, 1]
const SHARD_ORDER_LARGE = [46, 45, 49, 47, 48, 40, 42, 41, 43, 44, 35, 38, 39, 37, 36, 31, 34, 33, 32, 30, 28, 26, 27, 29, 25, 22, 24,
  20, 23, 21, 15, 16, 17, 19, 18, 11, 13, 12, 14, 10, 9, 7, 8, 6, 5, 1, 3, 0, 4, 2]

export function dryRun(data: Input) {
  if (data.DryRun === true) throw clientError('DryRunOperationException', 'Request would have succeeded, but DryRun flag is set.')
}

function writableStream(context: Context, name: string) {
  const stream = getStream(context, name)
  if (stream.StreamStatus !== 'ACTIVE' && stream.StreamStatus !== 'UPDATING') {
    throw resourceNotFound(`Stream ${name} under account ${account(context)} not found.`)
  }
  return stream
}

function hashKeyOf(stream: StreamDoc, record: Input) {
  if (stream.RecordDistributionStrategy === 'AUTO') return BigInt('0x' + randomBytes(16).toString('hex'))
  if (record.ExplicitHashKey != null) {
    const hashKey = BigInt(record.ExplicitHashKey)
    if (hashKey < 0n || hashKey >= POW_2_128) {
      throw invalidArgument('Invalid ExplicitHashKey. ExplicitHashKey must be in the range: [0, 2^128-1]. ' +
        `Specified value was ${record.ExplicitHashKey}`)
    }
    return hashKey
  }
  return partitionKeyToHashKey(record.PartitionKey as string)
}

function locateShard(stream: StreamDoc, hashKey: bigint) {
  for (let i = 0; i < stream.Shards.length; i++) {
    const shard = stream.Shards[i]!
    if (isOpen(shard) && hashKey >= BigInt(shard.HashKeyRange.StartingHashKey) && hashKey <= BigInt(shard.HashKeyRange.EndingHashKey)) {
      return { shardIx: i, shardId: shard.ShardId, shardCreateTime: shardCreateTime(shard) }
    }
  }
  throw new KinesisError('InternalFailure', `No open shard covers hash key ${hashKey}`, 500)
}

function nextSequence(stream: StreamDoc, shardIx: number, createTime: number) {
  const group = Math.floor(shardIx / 5)
  const now = Math.max(Date.now(), createTime)
  if (!stream._seqIx[group]) stream._seqIx[group] = createTime === now ? 1 : 0
  const sequenceNumber = stringifySequence({ shardCreateTime: createTime, shardIx, seqIx: stream._seqIx[group], seqTime: now })
  stream._seqIx[group] = stream._seqIx[group]! + 1
  return { sequenceNumber, now }
}

function encryptionOf(stream: StreamDoc) {
  return stream.EncryptionType === 'KMS' ? 'KMS' : null
}

function notify(context: Context, name: string, shardIxs: Iterable<number>) {
  for (const shardIx of new Set(shardIxs)) context.store.events.emit('records', name, shardIx)
}

export function putRecord(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = writableStream(context, name)
  const hashKey = hashKeyOf(stream, data)
  if (data.SequenceNumberForOrdering != null) {
    let valid = true
    try {
      valid = !(parseSequence(data.SequenceNumberForOrdering).seqTime > Date.now())
    } catch {
      valid = false
    }
    if (!valid) {
      throw invalidArgument(`ExclusiveMinimumSequenceNumber ${data.SequenceNumberForOrdering} used in PutRecord on stream ${name} ` +
        `under account ${account(context)} is invalid.`)
    }
  }
  const target = locateShard(stream, hashKey)
  dryRun(data)
  const { sequenceNumber, now } = nextSequence(stream, target.shardIx, target.shardCreateTime)
  const encryptionType = encryptionOf(stream)
  context.store.transaction(() => {
    context.store.saveStream(stream)
    context.store.insertRecords(name, [{
      shardIx: target.shardIx,
      sequenceNumber,
      partitionKey: data.PartitionKey ?? null,
      data: data.Data as Buffer,
      arrival: now / 1000,
      encryptionType,
    }])
  })
  notify(context, name, [target.shardIx])
  const result: Record<string, unknown> = { ShardId: target.shardId, SequenceNumber: sequenceNumber }
  if (encryptionType) result.EncryptionType = encryptionType
  return result
}

export function putRecords(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = writableStream(context, name)
  const records = data.Records as Input[]
  const targets = records.map(record => locateShard(stream, hashKeyOf(stream, record)))
  dryRun(data)
  const order = stream.Shards.length < 18 ? SHARD_ORDER_SMALL : stream.Shards.length < 27 ? SHARD_ORDER_MEDIUM : SHARD_ORDER_LARGE
  const shardOrder = [...order]
  for (let i = 50; i < stream.Shards.length; i++) shardOrder.push(i)
  const encryptionType = encryptionOf(stream)
  const results: Record<string, unknown>[] = new Array(records.length)
  const rows: NewRecord[] = []
  for (const shardIx of shardOrder) {
    if (shardIx >= stream.Shards.length) continue
    for (let i = 0; i < records.length; i++) {
      const target = targets[i]!
      if (target.shardIx !== shardIx) continue
      const { sequenceNumber, now } = nextSequence(stream, shardIx, target.shardCreateTime)
      rows.push({
        shardIx,
        sequenceNumber,
        partitionKey: records[i]!.PartitionKey ?? null,
        data: records[i]!.Data as Buffer,
        arrival: now / 1000,
        encryptionType,
      })
      results[i] = { SequenceNumber: sequenceNumber, ShardId: target.shardId }
    }
  }
  context.store.transaction(() => {
    context.store.saveStream(stream)
    context.store.insertRecords(name, rows)
  })
  notify(context, name, targets.map(target => target.shardIx))
  const result: Record<string, unknown> = { FailedRecordCount: 0, Records: results }
  if (encryptionType) result.EncryptionType = encryptionType
  return result
}

function latestSequence(stream: StreamDoc, shardIx: number, now = Date.now()) {
  const shard = stream.Shards[shardIx]!
  const start = parseSequence(shard.SequenceNumberRange.StartingSequenceNumber)
  return stringifySequence({
    shardCreateTime: start.shardCreateTime,
    seqIx: stream._seqIx[Math.floor(shardIx / 5)] ?? null,
    seqTime: now,
    shardIx: start.shardIx,
  })
}

export interface StartingPosition {
  Type: string
  SequenceNumber?: string
  Timestamp?: number
}

export function startingSequence(context: Context, stream: StreamDoc, shardIx: number, shardId: string, position: StartingPosition, operation: string) {
  const name = stream.StreamName
  const shard = stream.Shards[shardIx]!
  const shardSequence = shard.SequenceNumberRange.StartingSequenceNumber
  const shardSequenceParts = parseSequence(shardSequence)
  const now = Date.now()
  if (position.SequenceNumber) {
    if (position.Type === 'TRIM_HORIZON' || position.Type === 'LATEST') {
      throw invalidArgument('Must either specify (1) AT_SEQUENCE_NUMBER or AFTER_SEQUENCE_NUMBER and StartingSequenceNumber or ' +
        '(2) TRIM_HORIZON or LATEST and no StartingSequenceNumber. ' +
        `Request specified ${position.Type} and also a StartingSequenceNumber.`)
    }
    let parts: ParsedSequence
    try {
      parts = parseSequence(position.SequenceNumber)
    } catch {
      throw invalidArgument(`StartingSequenceNumber ${position.SequenceNumber} used in ${operation} on shard ${shardId} ` +
        `in stream ${name} under account ${account(context)} is invalid.`)
    }
    if (parts.shardIx !== shardIx) {
      throw invalidArgument(`Invalid StartingSequenceNumber. It encodes ${shardIdName(parts.shardIx)}, ` +
        `while it was used in a call to a shard with ${shardId}`)
    }
    if (parts.version !== shardSequenceParts.version || parts.shardCreateTime !== shardSequenceParts.shardCreateTime) {
      if (parts.version === 0) throw serverError()
      throw invalidArgument(`StartingSequenceNumber ${position.SequenceNumber} used in ${operation} on shard ${shardId} ` +
        `in stream ${name} under account ${account(context)} is invalid because it did not come from this stream.`)
    }
    return position.Type === 'AT_SEQUENCE_NUMBER' ? position.SequenceNumber : incrementSequence(parts)
  }
  if (position.Type === 'TRIM_HORIZON') return shardSequence
  if (position.Type === 'LATEST') return latestSequence(stream, shardIx, now)
  if (position.Type === 'AT_TIMESTAMP') {
    if (position.Timestamp == null) {
      throw invalidArgument('Must specify timestampInMillis parameter for iterator of type AT_TIMESTAMP. Current request has no timestamp parameter.')
    }
    const timestampInMillis = position.Timestamp * 1000
    if (timestampInMillis > now) {
      throw invalidArgument('The timestampInMillis parameter cannot be greater than the currentTimestampInMillis. ' +
        `timestampInMillis: ${timestampInMillis}, currentTimestampInMillis: ${now}`)
    }
    return context.store.firstSequenceAtOrAfter(name, shardIx, position.Timestamp) ?? latestSequence(stream, shardIx, now)
  }
  throw invalidArgument('Must either specify (1) AT_SEQUENCE_NUMBER or AFTER_SEQUENCE_NUMBER and StartingSequenceNumber or ' +
    '(2) TRIM_HORIZON or LATEST and no StartingSequenceNumber. ' +
    `Request specified ${position.Type} and no StartingSequenceNumber.`)
}

export function getShardIterator(context: Context, data: Input) {
  const name = streamNameOf(data)
  const shard = resolveShardId(data.ShardId)
  if (!shard) {
    throw resourceNotFound(`Could not find shard ${data.ShardId} in stream ${name} under account ${account(context)}.`)
  }
  const stream = context.store.streams.get(name)
  if (!stream || shard.shardIx >= stream.Shards.length) {
    throw resourceNotFound(`Shard ${shard.shardId} in stream ${name} under account ${account(context)} does not exist`)
  }
  const position: StartingPosition = { Type: data.ShardIteratorType }
  if (data.StartingSequenceNumber != null) position.SequenceNumber = data.StartingSequenceNumber
  if (data.Timestamp != null) position.Timestamp = data.Timestamp
  const sequence = startingSequence(context, stream, shard.shardIx, shard.shardId, position, 'GetShardIterator')
  dryRun(data)
  return { ShardIterator: createShardIterator(name, shard.shardId, sequence) }
}

function invalidIterator() {
  return invalidArgument('Invalid ShardIterator.')
}

function amzUtc(time: number) {
  const pieces = new Date(time).toUTCString().match(/^(.+), (.+) (.+) (.+) (.+) GMT$/)!
  return [pieces[1], pieces[3], pieces[2], pieces[5], 'UTC', pieces[4]].join(' ')
}

export function childShards(stream: StreamDoc, shardId: string) {
  return stream.Shards
    .filter(shard => shard.ParentShardId === shardId || shard.AdjacentParentShardId === shardId)
    .map(shard => ({
      ShardId: shard.ShardId,
      ParentShards: [shard.ParentShardId, shard.AdjacentParentShardId].filter((id): id is string => id !== undefined),
      HashKeyRange: shard.HashKeyRange,
    }))
}

export interface ReadResult {
  records: Record<string, unknown>[]
  nextSequence: string
  shardEnded: boolean
  millisBehindLatest: number
}

export function readShard(context: Context, stream: StreamDoc, shardIx: number, sequence: ParsedSequence, sequenceText: string, limit: number): ReadResult {
  const { store } = context
  const now = Date.now()
  const cutoff = now - stream.RetentionPeriodHours * 60 * 60 * 1000
  const rows = store.readRecords(stream.StreamName, shardIx, sequenceText, limit)
  const expired: string[] = []
  const records: Record<string, unknown>[] = []
  let last: ParsedSequence | undefined
  for (const row of rows) {
    last = parseSequence(row.SequenceNumber)
    if (last.seqTime < cutoff) {
      expired.push(row.SequenceNumber)
      continue
    }
    const record: Record<string, unknown> = {}
    if (row.PartitionKey !== null) record.PartitionKey = row.PartitionKey
    record.Data = row.Data
    record.ApproximateArrivalTimestamp = row.ApproximateArrivalTimestamp
    record.SequenceNumber = row.SequenceNumber
    if (row.EncryptionType) record.EncryptionType = row.EncryptionType
    records.push(record)
  }
  const defaultTime = sequence.seqTime > now ? sequence.seqTime : now
  const nextSequence = incrementSequence(last ?? sequence, last ? undefined : defaultTime)
  let shardEnded = false
  const shard: ShardDoc = stream.Shards[shardIx]!
  if (!records.length && shard.SequenceNumberRange.EndingSequenceNumber) {
    const end = parseSequence(shard.SequenceNumberRange.EndingSequenceNumber)
    if (sequence.seqTime >= end.seqTime) shardEnded = true
  }
  const lastRow = rows.at(-1)
  const newest = store.lastRecord(stream.StreamName, shardIx)
  const millisBehindLatest = lastRow && newest && newest.seq > lastRow.SequenceNumber
    ? Math.max(1, now - Math.round(lastRow.ApproximateArrivalTimestamp * 1000))
    : 0
  if (expired.length) setImmediate(() => store.deleteRecords(stream.StreamName, shardIx, expired))
  return { records, nextSequence, shardEnded, millisBehindLatest }
}

export function getRecords(context: Context, data: Input) {
  const now = Date.now()
  const iterator = readShardIterator(data.ShardIterator)
  if (!iterator) throw invalidIterator()
  const { createdAt, streamName, shardId, sequenceNumber } = iterator
  const shardIx = parseInt(shardId.split('-')[1] ?? '', 10)
  if (!/^shardId-[\d]{12}$/.test(shardId) || !(shardIx >= 0 && shardIx < 2147483648)) throw invalidIterator()
  if (!(createdAt > 0 && createdAt <= now)) throw invalidIterator()
  if (!/[a-zA-Z0-9_.-]+/.test(streamName) || !streamName.length || streamName.length > 128) throw invalidIterator()
  if (now - createdAt > ITERATOR_TTL_MS) {
    throw clientError('ExpiredIteratorException', `Iterator expired. The iterator was created at time ${amzUtc(createdAt)} ` +
      `while right now it is ${amzUtc(now)} which is further in the future than the tolerated delay of ${ITERATOR_TTL_MS} milliseconds.`)
  }
  let sequence: ParsedSequence
  try {
    sequence = parseSequence(sequenceNumber)
  } catch {
    throw invalidIterator()
  }
  const stream = context.store.streams.get(streamName)
  if (!stream || shardIx >= stream.Shards.length) {
    throw resourceNotFound(`Shard ${shardId} in stream ${streamName} under account ${account(context)} does not exist`)
  }
  dryRun(data)
  const result = readShard(context, stream, shardIx, sequence, sequenceNumber, (data.Limit as number | undefined) || 10000)
  const response: Record<string, unknown> = {
    MillisBehindLatest: result.millisBehindLatest,
    NextShardIterator: result.shardEnded ? undefined : createShardIterator(streamName, shardId, result.nextSequence),
    Records: result.records,
  }
  if (result.shardEnded) response.ChildShards = childShards(stream, shardId)
  return response
}

