import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { AccountSettings, ChannelDoc, ConsumerDoc, NewRecord, Pending, StoredRecord, StreamDoc } from './types.ts'

export const DATABASE_FILE = 'aws-kinesis-local.sqlite'

export interface StoreOptions {
  path?: string | undefined
  createStreamMs: number
  deleteStreamMs: number
  updateStreamMs: number
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

export class Store {
  readonly options: StoreOptions
  readonly streams = new Map<string, StreamDoc>()
  readonly consumers = new Map<string, ConsumerDoc>()
  readonly channels = new Map<string, ChannelDoc>()
  readonly policies = new Map<string, string>()
  readonly events = new EventEmitter()
  settings: AccountSettings = { MinimumThroughputBillingCommitment: { Status: 'DISABLED' } }
  private readonly db: DatabaseSync
  private readonly transitions = new Map<string, Transition>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly statements: Record<string, StatementSync>
  private closed = false

  constructor(options: StoreOptions) {
    this.options = options
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
      deleteRecord: this.db.prepare('DELETE FROM records WHERE stream = ? AND shard = ? AND seq = ?'),
      deleteStreamRecords: this.db.prepare('DELETE FROM records WHERE stream = ?'),
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
    this.cancel('channel', arn)
    this.channels.delete(arn)
    this.erase('channel', arn)
    this.removePolicy(arn)
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

  insertRecords(stream: string, records: NewRecord[]) {
    for (const record of records) {
      this.statements.putRecord!.run(stream, record.shardIx, record.sequenceNumber, record.partitionKey, record.data, record.arrival, record.encryptionType)
    }
  }

  readRecords(stream: string, shardIx: number, fromSequence: string, limit: number): StoredRecord[] {
    return (this.statements.readRecords!.all(stream, shardIx, fromSequence, limit) as unknown as RecordRow[]).map(row => ({
      SequenceNumber: row.seq,
      PartitionKey: row.partition_key,
      Data: Buffer.from(row.data),
      ApproximateArrivalTimestamp: row.arrival,
      EncryptionType: row.encryption,
    }))
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

  registerTransition(action: string, transition: Transition) {
    this.transitions.set(action, transition)
  }

  schedule(kind: Kind, key: string, action: string, delayMs: number, data?: unknown) {
    const doc = this.collection(kind).get(key)
    if (!doc) return
    const pending: Pending = { action, due: Date.now() + delayMs }
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
    }, Math.max(0, pending.due - Date.now()))
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

  resume() {
    for (const kind of ['stream', 'consumer', 'channel'] as const) {
      for (const [key, doc] of [...this.collection(kind)]) {
        if (doc._pending) this.arm(kind, key, doc._pending)
      }
    }
  }

  close() {
    if (this.closed) return
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.events.emit('close')
    this.closed = true
    this.db.close()
  }
}
