import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { parseSequence } from '../kinesis/sequence.ts'
import type { Logger } from '../logger.ts'
import type { AccountSettings, ChannelDoc, ConsumerDoc, NewRecord, Pending, StoredRecord, StreamDoc } from './types.ts'

export const DATABASE_FILE = 'aws-kinesis-local.sqlite'
export const MAX_CLOCK_ADVANCE_SECONDS = 10 * 365 * 24 * 60 * 60
const EXPIRY_BATCH_SIZE = 500
const CLOCK_KEY = 'clockOffsetMs'

const defaultSettings = (): AccountSettings => ({ MinimumThroughputBillingCommitment: { Status: 'DISABLED' } })

export interface StoreOptions {
  path?: string | undefined
  createStreamMs: number
  deleteStreamMs: number
  updateStreamMs: number
  expiryIntervalMs: number
  shardLimit: number
  accountId: string
  region: string
}

type Kind = 'stream' | 'consumer' | 'channel'
type Doc = StreamDoc | ConsumerDoc | ChannelDoc
export type Transition = (store: Store, key: string, data: unknown) => void

interface RecordRow {
  seq: string
  partition_key: string | null
  data: Uint8Array
  arrival: number
  encryption: string | null
}

export function validClockAdvance(seconds: unknown): seconds is number {
  return typeof seconds === 'number' && seconds >= 0 && seconds <= MAX_CLOCK_ADVANCE_SECONDS
}

function storedRecord(row: RecordRow): StoredRecord {
  return {
    SequenceNumber: row.seq,
    PartitionKey: row.partition_key,
    Data: Buffer.from(row.data),
    ApproximateArrivalTimestamp: row.arrival,
    EncryptionType: row.encryption,
  }
}

export class Store {
  readonly options: StoreOptions
  private readonly logger: Logger
  readonly streams = new Map<string, StreamDoc>()
  readonly consumers = new Map<string, ConsumerDoc>()
  readonly channels = new Map<string, ChannelDoc>()
  readonly policies = new Map<string, string>()
  readonly events = new EventEmitter()
  settings: AccountSettings = defaultSettings()
  draining = false
  private readonly db: DatabaseSync
  private readonly transitions = new Map<string, Transition>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly statements: Record<string, StatementSync>
  private offsetMs = 0
  private closed = false

  constructor(options: StoreOptions, logger: Logger) {
    this.options = options
    this.logger = logger
    this.events.setMaxListeners(0)
    let file = ':memory:'
    if (options.path) {
      mkdirSync(options.path, { recursive: true })
      file = join(options.path, DATABASE_FILE)
    }
    this.db = new DatabaseSync(file)
    if (file !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, key TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (kind, key));
      CREATE TABLE IF NOT EXISTS records (
        stream TEXT NOT NULL,
        shard INTEGER NOT NULL,
        seq TEXT NOT NULL,
        partition_key TEXT,
        data BLOB NOT NULL,
        arrival REAL NOT NULL,
        encryption TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS records_position ON records (stream, shard, seq);
      CREATE TABLE IF NOT EXISTS delivery_positions (
        channel TEXT NOT NULL,
        stream TEXT NOT NULL,
        shard INTEGER NOT NULL,
        seq TEXT NOT NULL,
        PRIMARY KEY (channel, stream, shard)
      );
      INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema', '1');
    `)
    this.statements = {
      putDocument: this.db.prepare('INSERT OR REPLACE INTO documents (kind, key, doc) VALUES (?, ?, ?)'),
      deleteDocument: this.db.prepare('DELETE FROM documents WHERE kind = ? AND key = ?'),
      allDocuments: this.db.prepare('SELECT kind, key, doc FROM documents'),
      putRecord: this.db.prepare('INSERT OR REPLACE INTO records (stream, shard, seq, partition_key, data, arrival, encryption) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      readRecords: this.db.prepare('SELECT seq, partition_key, data, arrival, encryption FROM records WHERE stream = ? AND shard = ? AND seq >= ? ORDER BY seq LIMIT ?'),
      firstAtOrAfter: this.db.prepare('SELECT seq FROM records WHERE stream = ? AND shard = ? AND arrival >= ? ORDER BY seq LIMIT 1'),
      lastRecord: this.db.prepare('SELECT seq, arrival FROM records WHERE stream = ? AND shard = ? ORDER BY seq DESC LIMIT 1'),
      oldestSequences: this.db.prepare('SELECT seq FROM records WHERE stream = ? AND shard = ? ORDER BY seq LIMIT ?'),
      deleteRecord: this.db.prepare('DELETE FROM records WHERE stream = ? AND shard = ? AND seq = ?'),
      deleteStreamRecords: this.db.prepare('DELETE FROM records WHERE stream = ?'),
      deliveryRecords: this.db.prepare('SELECT seq, partition_key, data, arrival, encryption FROM records WHERE stream = ? AND shard = ? AND seq > ? AND arrival >= ? ORDER BY seq LIMIT ?'),
      deliveryPositions: this.db.prepare('SELECT shard, seq FROM delivery_positions WHERE channel = ? AND stream = ?'),
      putDeliveryPosition: this.db.prepare('INSERT OR REPLACE INTO delivery_positions (channel, stream, shard, seq) VALUES (?, ?, ?, ?)'),
      deleteDeliveryPositions: this.db.prepare('DELETE FROM delivery_positions WHERE channel = ?'),
      schemaVersion: this.db.prepare("SELECT value FROM metadata WHERE key = 'schema'"),
      readMetadata: this.db.prepare('SELECT value FROM metadata WHERE key = ?'),
      putMetadata: this.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'),
      deleteMetadata: this.db.prepare('DELETE FROM metadata WHERE key = ?'),
    }
    this.load()
  }

  private load() {
    for (const row of this.statements.allDocuments!.all() as { kind: string, key: string, doc: string }[]) {
      const doc = JSON.parse(row.doc)
      if (row.kind === 'stream') this.streams.set(row.key, doc)
      else if (row.kind === 'consumer') this.consumers.set(row.key, doc)
      else if (row.kind === 'channel') this.channels.set(row.key, doc)
      else if (row.kind === 'policy') this.policies.set(row.key, doc)
      else if (row.kind === 'settings') this.settings = doc
    }
    const offset = this.statements.readMetadata!.get(CLOCK_KEY) as { value: string } | undefined
    if (offset) this.offsetMs = Number(offset.value)
  }

  now() {
    return Date.now() + this.offsetMs
  }

  advanceClock(seconds: number) {
    if (!validClockAdvance(seconds)) throw new RangeError(`The clock moves forward by a number of seconds from 0 to ${MAX_CLOCK_ADVANCE_SECONDS}.`)
    this.offsetMs += Math.round(seconds * 1000)
    this.saveOffset()
    for (;;) {
      const next = this.pendingDocs().filter(entry => entry.pending.due <= this.now()).sort((a, b) => a.pending.due - b.pending.due)[0]
      if (!next || this.closed) break
      this.cancel(next.kind, next.key)
      this.fire(next.kind, next.key)
    }
    this.resume()
    this.events.emit('clock')
    return this.offsetMs / 1000
  }

  private saveOffset() {
    if (this.closed) return
    if (this.offsetMs) this.statements.putMetadata!.run(CLOCK_KEY, String(this.offsetMs))
    else this.statements.deleteMetadata!.run(CLOCK_KEY)
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private collection(kind: Kind): Map<string, Doc> {
    return (kind === 'stream' ? this.streams : kind === 'consumer' ? this.consumers : this.channels) as Map<string, Doc>
  }

  private write(kind: string, key: string, doc: unknown) {
    if (this.closed) return
    this.statements.putDocument!.run(kind, key, JSON.stringify(doc))
  }

  private erase(kind: string, key: string) {
    if (this.closed) return
    this.statements.deleteDocument!.run(kind, key)
  }

  saveStream(doc: StreamDoc) {
    this.streams.set(doc.StreamName, doc)
    this.write('stream', doc.StreamName, doc)
  }

  removeStream(name: string) {
    this.cancel('stream', name)
    this.streams.delete(name)
    this.erase('stream', name)
    if (!this.closed) this.statements.deleteStreamRecords!.run(name)
  }

  saveConsumer(doc: ConsumerDoc) {
    this.consumers.set(doc.ConsumerARN, doc)
    this.write('consumer', doc.ConsumerARN, doc)
  }

  removeConsumer(arn: string) {
    this.cancel('consumer', arn)
    this.consumers.delete(arn)
    this.erase('consumer', arn)
    this.removePolicy(arn)
    this.events.emit('consumer-removed', arn)
  }

  saveChannel(doc: ChannelDoc) {
    this.channels.set(doc.ChannelARN, doc)
    this.write('channel', doc.ChannelARN, doc)
  }

  removeChannel(arn: string) {
    const channel = this.channels.get(arn)
    this.cancel('channel', arn)
    this.channels.delete(arn)
    this.erase('channel', arn)
    if (channel && !this.closed) this.statements.deleteDeliveryPositions!.run(channel.ChannelId)
    this.removePolicy(arn)
    this.events.emit('channel-removed', arn)
  }

  savePolicy(arn: string, policy: string) {
    this.policies.set(arn, policy)
    this.write('policy', arn, policy)
  }

  removePolicy(arn: string) {
    if (!this.policies.delete(arn)) return
    this.erase('policy', arn)
  }

  saveSettings(settings: AccountSettings) {
    this.settings = settings
    this.write('settings', 'account', settings)
  }

  reset(name?: string) {
    const names = name === undefined ? [...this.streams.keys()].sort() : this.streams.has(name) ? [name] : []
    const arns = new Set(names.map(stream => this.streams.get(stream)!.StreamARN))
    const consumers = [...this.consumers.values()].filter(consumer => names.includes(consumer.StreamName))
    const channels = [...this.channels.values()].filter(channel =>
      name === undefined || channel.StreamConfigurationList.some(entry => arns.has(entry.StreamARN as string)))
    this.transaction(() => {
      for (const stream of names) {
        this.events.emit('stream-deleted', stream)
        this.removePolicy(this.streams.get(stream)!.StreamARN)
        this.removeStream(stream)
      }
      for (const consumer of consumers) this.removeConsumer(consumer.ConsumerARN)
      for (const channel of channels) this.removeChannel(channel.ChannelARN)
      if (name === undefined) {
        for (const arn of [...this.policies.keys()]) this.removePolicy(arn)
        this.settings = defaultSettings()
        this.erase('settings', 'account')
        this.offsetMs = 0
        this.saveOffset()
      }
    })
    return names
  }

  insertRecords(stream: string, records: NewRecord[]) {
    for (const record of records) {
      this.statements.putRecord!.run(stream, record.shardIx, record.sequenceNumber, record.partitionKey, record.data, record.arrival, record.encryptionType)
    }
  }

  readRecords(stream: string, shardIx: number, fromSequence: string, limit: number): StoredRecord[] {
    return (this.statements.readRecords!.all(stream, shardIx, fromSequence, limit) as unknown as RecordRow[]).map(storedRecord)
  }

  readDeliveryRecords(stream: string, shardIx: number, afterSequence: string, arrivedSince: number, limit: number): StoredRecord[] {
    return (this.statements.deliveryRecords!.all(stream, shardIx, afterSequence, arrivedSince, limit) as unknown as RecordRow[]).map(storedRecord)
  }

  deliveryPositions(channelId: string, stream: string) {
    const rows = this.statements.deliveryPositions!.all(channelId, stream) as { shard: number, seq: string }[]
    return new Map(rows.map(row => [row.shard, row.seq]))
  }

  saveDeliveryPositions(channelId: string, stream: string, positions: Map<number, string>) {
    if (this.closed) return
    this.transaction(() => {
      for (const [shardIx, sequenceNumber] of positions) this.statements.putDeliveryPosition!.run(channelId, stream, shardIx, sequenceNumber)
    })
  }

  firstSequenceAtOrAfter(stream: string, shardIx: number, timestamp: number) {
    return (this.statements.firstAtOrAfter!.get(stream, shardIx, timestamp) as { seq: string } | undefined)?.seq
  }

  lastRecord(stream: string, shardIx: number) {
    return this.statements.lastRecord!.get(stream, shardIx) as { seq: string, arrival: number } | undefined
  }

  deleteRecords(stream: string, shardIx: number, sequenceNumbers: string[]) {
    if (this.closed) return
    for (const sequenceNumber of sequenceNumbers) this.statements.deleteRecord!.run(stream, shardIx, sequenceNumber)
  }

  deleteStreamRecords(stream: string) {
    if (this.closed) return
    this.statements.deleteStreamRecords!.run(stream)
  }

  startExpiry() {
    this.scheduleExpiry(0, this.expiryBatches())
  }

  private scheduleExpiry(delayMs: number, batches: Generator<void>) {
    this.timers.set('expiry', setTimeout(() => this.expireBatch(batches), delayMs))
  }

  private expireBatch(batches: Generator<void>) {
    let done: boolean | undefined = true
    try {
      done = batches.next().done
    } catch (error) {
      this.logger.log('error', { message: 'Record expiry failed', error: error instanceof Error ? error.stack : error })
    }
    if (done) this.scheduleExpiry(this.options.expiryIntervalMs, this.expiryBatches())
    else this.scheduleExpiry(0, batches)
  }

  private *expiryBatches(): Generator<void> {
    for (const stream of [...this.streams.values()]) {
      for (let shardIx = 0; shardIx < stream.Shards.length; shardIx++) {
        while (this.expireOldest(stream, shardIx) === EXPIRY_BATCH_SIZE) yield
        yield
      }
    }
  }

  private expireOldest(stream: StreamDoc, shardIx: number) {
    const cutoff = this.now() - stream.RetentionPeriodHours * 60 * 60 * 1000
    const oldest = this.statements.oldestSequences!.all(stream.StreamName, shardIx, EXPIRY_BATCH_SIZE) as { seq: string }[]
    const expired: string[] = []
    for (const { seq } of oldest) {
      if (parseSequence(seq).seqTime >= cutoff) break
      expired.push(seq)
    }
    if (expired.length) this.transaction(() => this.deleteRecords(stream.StreamName, shardIx, expired))
    return expired.length
  }

  registerTransition(action: string, transition: Transition) {
    this.transitions.set(action, transition)
  }

  schedule(kind: Kind, key: string, action: string, delayMs: number, data?: unknown) {
    const doc = this.collection(kind).get(key)
    if (!doc) return
    const pending: Pending = { action, due: this.now() + delayMs }
    if (data !== undefined) pending.data = data
    doc._pending = pending
    this.persist(kind, doc)
    this.arm(kind, key, pending)
  }

  private persist(kind: Kind, doc: Doc) {
    if (kind === 'stream') this.saveStream(doc as StreamDoc)
    else if (kind === 'consumer') this.saveConsumer(doc as ConsumerDoc)
    else this.saveChannel(doc as ChannelDoc)
  }

  private arm(kind: Kind, key: string, pending: Pending) {
    const id = `${kind}:${key}`
    clearTimeout(this.timers.get(id))
    const timer = setTimeout(() => {
      this.timers.delete(id)
      this.fire(kind, key)
    }, Math.max(0, pending.due - this.now()))
    this.timers.set(id, timer)
  }

  private fire(kind: Kind, key: string) {
    if (this.closed) return
    const doc = this.collection(kind).get(key)
    const pending = doc?._pending
    if (!doc || !pending) return
    delete doc._pending
    const transition = this.transitions.get(pending.action)
    if (!transition) throw new Error(`No transition registered for ${pending.action}`)
    transition(this, key, pending.data)
    const current = this.collection(kind).get(key)
    if (current === doc && !doc._pending) this.persist(kind, doc)
  }

  cancel(kind: Kind, key: string) {
    const id = `${kind}:${key}`
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
  }

  private pendingDocs() {
    return (['stream', 'consumer', 'channel'] as const).flatMap(kind => [...this.collection(kind)]
      .filter(([, doc]) => doc._pending)
      .map(([key, doc]) => ({ kind, key, pending: doc._pending! })))
  }

  resume() {
    for (const { kind, key, pending } of this.pendingDocs()) this.arm(kind, key, pending)
  }

  healthy() {
    if (this.closed) return false
    try {
      this.statements.schemaVersion!.get()
      return true
    } catch {
      return false
    }
  }

  drain() {
    if (this.draining) return
    this.draining = true
    this.events.emit('drain')
  }

  close() {
    if (this.closed) return
    this.drain()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.closed = true
    this.db.close()
  }
}
