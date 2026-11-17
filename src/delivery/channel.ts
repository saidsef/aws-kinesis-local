import { promisify } from 'node:util'
import { gzip, zstdCompress } from 'node:zlib'
import type { Logger } from '../logger.ts'
import { streamNameFromArn } from '../operations/common.ts'
import type { Store } from '../store/store.ts'
import type { ChannelDoc, StoredRecord, StreamDoc } from '../store/types.ts'
import { objectKey } from './key-template.ts'
import { putObject, type S3Client } from './s3.ts'

const PAGE_SIZE = 1000
const MAX_OBJECT_BYTES = 64 * 1024 * 1024
const NEWLINE = Buffer.from('\n')
const DEFAULT_ERROR_PREFIX = 'errors/'
const ERROR_KEY_TEMPLATE = '!{channel-name}/!{channel-id}/!{yyyy}/!{MM}/!{dd}/!{HH}/!{stream-name}-!{yyyy}-!{MM}-!{dd}-!{HH}-!{mm}!{extension:.json}'
const UTF8 = new TextDecoder('utf-8', { fatal: true })

const COMPRESSORS: Record<string, (data: Buffer) => Promise<Buffer>> = {
  NONE: async data => data,
  GZIP: promisify(gzip),
  ZSTD: promisify(zstdCompress),
}

export interface BatchRecord extends StoredRecord {
  ShardId: string
}

export interface Batch {
  records: BatchRecord[]
  positions: Map<number, string>
  full: boolean
}

interface Worker {
  channel: ChannelDoc
  timer?: NodeJS.Timeout
}

function delivering(channel: ChannelDoc) {
  return (channel.ChannelStatus === 'ACTIVE' || channel.ChannelStatus === 'UPDATING') && channel.S3DestinationConfiguration !== undefined
}

function bucketName(arn: string) {
  return arn.slice(arn.lastIndexOf(':') + 1)
}

export function formatError(data: Buffer, format: string) {
  if (format === 'BYTE_ARRAY') return undefined
  let text: string
  try {
    text = UTF8.decode(data)
  } catch {
    return 'The record is not valid UTF-8 text.'
  }
  if (format !== 'JSON') return undefined
  try {
    JSON.parse(text)
  } catch (error) {
    return `The record is not valid JSON: ${(error as Error).message}`
  }
  return undefined
}

// AWS writes record identifiers and error context to the dead-letter location, and not the record data.
function errorEntry(channel: ChannelDoc, streamARN: string, record: BatchRecord, reason: string) {
  return JSON.stringify({
    channelARN: channel.ChannelARN,
    streamARN,
    shardId: record.ShardId,
    sequenceNumber: record.SequenceNumber,
    approximateArrivalTimestamp: new Date(record.ApproximateArrivalTimestamp * 1000).toISOString(),
    errorCode: 'FormatMismatch',
    errorMessage: reason,
  })
}

function objectBody(records: StoredRecord[], format: string) {
  if (format === 'BYTE_ARRAY') return Buffer.concat(records.map(record => record.Data))
  return Buffer.concat(records.flatMap(record => [record.Data, NEWLINE]))
}

// Child shards come after their parents in stream.Shards, and a batch ends at its size limit, so a batch never takes a
// record from a child shard before it holds the last record of every parent.
export function nextBatch(store: Store, channel: ChannelDoc, stream: StreamDoc, maxBytes = MAX_OBJECT_BYTES): Batch {
  const saved = store.deliveryPositions(channel.ChannelId, stream.StreamName)
  const activatedAt = (channel._activatedAt ?? channel.ChannelCreationTimestamp * 1000) / 1000
  const batch: Batch = { records: [], positions: new Map(), full: false }
  let bytes = 0
  for (let shardIx = 0; shardIx < stream.Shards.length && !batch.full; shardIx++) {
    const { ShardId } = stream.Shards[shardIx]!
    const since = saved.has(shardIx) ? 0 : activatedAt
    let after = saved.get(shardIx) ?? ''
    let rows: StoredRecord[]
    do {
      rows = store.readDeliveryRecords(stream.StreamName, shardIx, after, since, PAGE_SIZE)
      for (const row of rows) {
        batch.records.push({ ...row, ShardId })
        batch.positions.set(shardIx, row.SequenceNumber)
        after = row.SequenceNumber
        bytes += row.Data.length
        if (bytes >= maxBytes) {
          batch.full = true
          break
        }
      }
    } while (!batch.full && rows.length === PAGE_SIZE)
  }
  return batch
}

export class ChannelDelivery {
  private readonly store: Store
  private readonly logger: Logger
  private readonly client: S3Client
  private readonly intervalMs: number | undefined
  private readonly workers = new Map<string, Worker>()
  private readonly running = new Set<Promise<void>>()
  private stopped = false
  private readonly onActive = (arn: string) => this.watch(arn)
  private readonly onRemoved = (arn: string) => this.forget(arn)

  constructor(store: Store, logger: Logger, client: S3Client, intervalMs?: number) {
    this.store = store
    this.logger = logger
    this.client = client
    this.intervalMs = intervalMs
  }

  start() {
    this.store.events.on('channel-active', this.onActive)
    this.store.events.on('channel-removed', this.onRemoved)
    for (const arn of this.store.channels.keys()) this.watch(arn)
  }

  async stop() {
    if (!this.stopped) {
      this.stopped = true
      this.store.events.off('channel-active', this.onActive)
      this.store.events.off('channel-removed', this.onRemoved)
      for (const arn of [...this.workers.keys()]) this.forget(arn)
    }
    await Promise.all(this.running)
  }

  private watch(arn: string) {
    const channel = this.store.channels.get(arn)
    if (this.stopped || !channel || !delivering(channel) || this.workers.get(arn)?.channel === channel) return
    this.forget(arn)
    const worker: Worker = { channel }
    this.workers.set(arn, worker)
    this.schedule(worker)
  }

  private forget(arn: string) {
    clearTimeout(this.workers.get(arn)?.timer)
    this.workers.delete(arn)
  }

  // A reset can replace a channel with a new one under the same ARN, so the worker compares the document itself.
  private current(worker: Worker) {
    return this.store.channels.get(worker.channel.ChannelARN) === worker.channel && delivering(worker.channel)
  }

  private schedule(worker: Worker) {
    const seconds = worker.channel.S3DestinationConfiguration!.DataFreshnessInSeconds as number
    worker.timer = setTimeout(() => {
      const run = this.deliver(worker)
      this.running.add(run)
      void run.finally(() => this.running.delete(run))
    }, this.intervalMs ?? seconds * 1000)
  }

  private async deliver(worker: Worker) {
    const { channel } = worker
    for (const entry of channel.StreamConfigurationList) {
      if (this.stopped || !this.current(worker)) break
      try {
        await this.deliverStream(worker, entry)
      } catch (error) {
        const stream = streamNameFromArn(entry.StreamARN as string)
        this.logger.log('error', { message: 'Channel delivery failed', channel: channel.ChannelName, stream, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (!this.stopped && this.current(worker)) this.schedule(worker)
    else if (this.workers.get(channel.ChannelARN) === worker) this.forget(channel.ChannelARN)
  }

  // The positions move only after the server accepts every object of a batch, so a failed upload leaves its records for
  // the next attempt. The error object goes first, and a failed destination upload then repeats only the error object.
  private async deliverStream(worker: Worker, entry: Record<string, unknown>) {
    const { channel } = worker
    const streamARN = entry.StreamARN as string
    const streamName = streamNameFromArn(streamARN)!
    const format = (entry.RecordConfiguration as { RecordFormatType: string }).RecordFormatType
    const destination = channel.S3DestinationConfiguration!
    const storage = destination.StorageConfiguration as Record<string, string>
    const deadLetter = destination.DeadLetterQueueS3Configuration as Record<string, string> | undefined
    const bucket = bucketName(storage.BucketARN!)
    const errorBucket = deadLetter ? bucketName(deadLetter.BucketARN!) : bucket
    const errorPrefix = deadLetter?.ErrorOutputPrefix ?? DEFAULT_ERROR_PREFIX
    const compressionType = storage.CompressionType!
    for (;;) {
      const stream = this.store.streams.get(streamName)
      if (this.stopped || !stream || !this.current(worker)) return
      const batch = nextBatch(this.store, channel, stream)
      if (!batch.records.length) return
      const values = { channelName: channel.ChannelName, channelId: channel.ChannelId, streamName, compressionType, time: new Date() }
      const valid: BatchRecord[] = []
      const errors: string[] = []
      for (const record of batch.records) {
        const reason = formatError(record.Data, format)
        if (reason === undefined) valid.push(record)
        else errors.push(errorEntry(channel, streamARN, record, reason))
      }
      const errorKey = errors.length ? `${errorPrefix}${objectKey(ERROR_KEY_TEMPLATE, values)}` : undefined
      const key = valid.length ? objectKey(storage.OutputKeyTemplate, values) : undefined
      if (errorKey) await putObject(this.client, { bucket: errorBucket, key: errorKey, body: `${errors.join('\n')}\n` })
      if (key) await putObject(this.client, { bucket, key, body: await COMPRESSORS[compressionType]!(objectBody(valid, format)) })
      if (!this.current(worker)) return
      this.store.saveDeliveryPositions(channel.ChannelId, streamName, batch.positions)
      const fields = { channel: channel.ChannelName, stream: streamName }
      if (errorKey) this.logger.log('warn', { message: 'Channel sent records to its dead-letter location', ...fields, bucket: errorBucket, key: errorKey, records: errors.length })
      if (key) this.logger.log('info', { message: 'Channel delivered an object', ...fields, bucket, key, records: valid.length })
      if (!batch.full) return
    }
  }
}
