import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { parseSequence } from '../kinesis/sequence.ts'
import type { DocumentKind, RecordQuery, StorageBackend, StoredDocument, StoredRecord, StreamDoc } from './types.ts'

export const DATABASE_FILE = 'aws-kinesis-local.sqlite'
const CLOCK_METADATA_KEY = 'clockOffsetMs'
const INCREMENTAL_VACUUM = 2

interface RecordRow {
  shard: number
  seq: string
  partition_key: string | null
  data: Uint8Array
  arrival: number
  encryption: string | null
}

function storedRecord(row: RecordRow): StoredRecord {
  return {
    shardIx: row.shard,
    sequenceNumber: row.seq,
    partitionKey: row.partition_key,
    data: row.data,
    arrival: row.arrival,
    encryptionType: row.encryption,
  }
}

export interface SqliteOptions {
  reclaimSpace?: boolean
}

export class SqliteBackend implements StorageBackend {
  private readonly db: DatabaseSync
  private readonly statements: Record<string, StatementSync>
  private readonly onDisk: boolean
  private readonly reclaimSpace: boolean

  constructor(path?: string, options: SqliteOptions = {}) {
    let file = ':memory:'
    if (path) {
      mkdirSync(path, { recursive: true })
      file = join(path, DATABASE_FILE)
    }
    this.db = new DatabaseSync(file)
    this.onDisk = file !== ':memory:'
    this.reclaimSpace = options.reclaimSpace ?? true
    if (this.reclaimSpace) this.db.exec('PRAGMA auto_vacuum = INCREMENTAL')
    if (this.onDisk) {
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
    const columns = 'shard, seq, partition_key, data, arrival, encryption'
    this.statements = {
      putDocument: this.db.prepare('INSERT OR REPLACE INTO documents (kind, key, doc) VALUES (?, ?, ?)'),
      deleteDocument: this.db.prepare('DELETE FROM documents WHERE kind = ? AND key = ?'),
      allDocuments: this.db.prepare('SELECT kind, key, doc FROM documents'),
      putRecord: this.db.prepare('INSERT OR REPLACE INTO records (stream, shard, seq, partition_key, data, arrival, encryption) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      readFrom: this.db.prepare(`SELECT ${columns} FROM records WHERE stream = ? AND shard = ? AND seq >= ? AND arrival >= ? ORDER BY seq LIMIT ?`),
      readAfter: this.db.prepare(`SELECT ${columns} FROM records WHERE stream = ? AND shard = ? AND seq > ? AND arrival >= ? ORDER BY seq LIMIT ?`),
      oldestSequences: this.db.prepare('SELECT seq FROM records WHERE stream = ? AND shard = ? ORDER BY seq LIMIT ?'),
      deleteRecord: this.db.prepare('DELETE FROM records WHERE stream = ? AND shard = ? AND seq = ?'),
      deleteStreamRecords: this.db.prepare('DELETE FROM records WHERE stream = ?'),
      deliveryPositions: this.db.prepare('SELECT shard, seq FROM delivery_positions WHERE channel = ? AND stream = ?'),
      putDeliveryPosition: this.db.prepare('INSERT OR REPLACE INTO delivery_positions (channel, stream, shard, seq) VALUES (?, ?, ?, ?)'),
      deleteDeliveryPositions: this.db.prepare('DELETE FROM delivery_positions WHERE channel = ?'),
      schemaVersion: this.db.prepare("SELECT value FROM metadata WHERE key = 'schema'"),
      readMetadata: this.db.prepare('SELECT value FROM metadata WHERE key = ?'),
      putMetadata: this.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'),
      deleteMetadata: this.db.prepare('DELETE FROM metadata WHERE key = ?'),
      autoVacuum: this.db.prepare('PRAGMA auto_vacuum'),
    }
    if (this.reclaimSpace) this.convertToIncrementalVacuum()
  }

  private convertToIncrementalVacuum() {
    const { auto_vacuum } = this.statements.autoVacuum!.get() as { auto_vacuum: number }
    if (auto_vacuum === INCREMENTAL_VACUUM) return
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL')
    this.db.exec('VACUUM')
    this.checkpoint()
  }

  private reclaim() {
    if (!this.reclaimSpace) return
    this.db.exec('PRAGMA incremental_vacuum')
    this.checkpoint()
  }

  private checkpoint() {
    if (this.onDisk) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  private transaction(work: () => void) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private writeDocument(document: StoredDocument) {
    if (document.kind === 'clock') this.statements.putMetadata!.run(CLOCK_METADATA_KEY, String(document.value))
    else this.statements.putDocument!.run(document.kind, document.key, JSON.stringify(document.value))
  }

  async readDocuments() {
    const rows = this.statements.allDocuments!.all() as { kind: StoredDocument['kind'], key: string, doc: string }[]
    const documents = rows.map(row => ({ kind: row.kind, key: row.key, value: JSON.parse(row.doc) }) as StoredDocument)
    const offset = this.statements.readMetadata!.get(CLOCK_METADATA_KEY) as { value: string } | undefined
    if (offset) documents.push({ kind: 'clock', key: 'offset', value: Number(offset.value) })
    return documents
  }

  async putDocument(document: StoredDocument) {
    this.writeDocument(document)
  }

  async deleteDocument(kind: DocumentKind, key: string) {
    if (kind === 'clock') this.statements.deleteMetadata!.run(CLOCK_METADATA_KEY)
    else this.statements.deleteDocument!.run(kind, key)
  }

  async putRecords(stream: StreamDoc, records: StoredRecord[]) {
    this.transaction(() => {
      this.writeDocument({ kind: 'stream', key: stream.StreamName, value: stream })
      for (const record of records) {
        this.statements.putRecord!.run(stream.StreamName, record.shardIx, record.sequenceNumber, record.partitionKey, record.data, record.arrival, record.encryptionType)
      }
    })
  }

  async readRecords(query: RecordQuery) {
    const arrivedSince = query.arrivedSince ?? 0
    const rows = query.after === undefined
      ? this.statements.readFrom!.all(query.stream, query.shardIx, query.from ?? '', arrivedSince, query.limit)
      : this.statements.readAfter!.all(query.stream, query.shardIx, query.after, arrivedSince, query.limit)
    return (rows as unknown as RecordRow[]).map(storedRecord)
  }

  async expireRecords(stream: string, shardIx: number, arrivedBefore: number, limit: number) {
    const oldest = this.statements.oldestSequences!.all(stream, shardIx, limit) as { seq: string }[]
    const expired: string[] = []
    for (const { seq } of oldest) {
      if (parseSequence(seq).seqTime >= arrivedBefore * 1000) break
      expired.push(seq)
    }
    if (expired.length) {
      this.transaction(() => {
        for (const seq of expired) this.statements.deleteRecord!.run(stream, shardIx, seq)
      })
      this.reclaim()
    }
    return expired.length
  }

  async deleteRecords(stream: string) {
    this.statements.deleteStreamRecords!.run(stream)
    this.reclaim()
  }

  async readDeliveryPositions(channelId: string, stream: string) {
    const rows = this.statements.deliveryPositions!.all(channelId, stream) as { shard: number, seq: string }[]
    return new Map(rows.map(row => [row.shard, row.seq]))
  }

  async putDeliveryPositions(channelId: string, stream: string, positions: Map<number, string>) {
    this.transaction(() => {
      for (const [shardIx, sequenceNumber] of positions) this.statements.putDeliveryPosition!.run(channelId, stream, shardIx, sequenceNumber)
    })
  }

  async deleteDeliveryPositions(channelId: string) {
    this.statements.deleteDeliveryPositions!.run(channelId)
  }

  async ping() {
    this.statements.schemaVersion!.get()
  }

  close() {
    this.db.close()
  }
}
