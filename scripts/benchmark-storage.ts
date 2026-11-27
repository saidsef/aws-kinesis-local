import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringifySequence } from '../src/kinesis/sequence.ts'
import { DATABASE_FILE, SqliteBackend } from '../src/store/sqlite.ts'
import type { StoredRecord, StreamDoc } from '../src/store/types.ts'

const RECORDS = Number(process.argv[2] ?? 100000)
const BATCH = 500
const DATA = Buffer.alloc(1024, 'x')
const CREATED = Date.UTC(2026, 0, 1)
const STREAM = { StreamName: 'benchmark' } as StreamDoc

const candidates: [string, boolean][] = [
  ['SQLite without auto-vacuum', false],
  ['SQLite with incremental vacuum', true],
]

function record(index: number): StoredRecord {
  return {
    shardIx: 0,
    sequenceNumber: stringifySequence({ shardCreateTime: CREATED, shardIx: 0, seqIx: index, seqTime: CREATED + index * 1000 }),
    partitionKey: 'p',
    data: DATA,
    arrival: CREATED / 1000 + index,
    encryptionType: null,
  }
}

function megabytes(path: string) {
  const file = join(path, DATABASE_FILE)
  const bytes = [file, `${file}-wal`].reduce((total, name) => total + (existsSync(name) ? statSync(name).size : 0), 0)
  return (bytes / 1024 / 1024).toFixed(1)
}

async function timed(work: () => Promise<number>) {
  const started = performance.now()
  const count = await work()
  return Math.round(count / ((performance.now() - started) / 1000))
}

async function write(backend: SqliteBackend, from: number, to: number) {
  for (let first = from; first < to; first += BATCH) {
    await backend.putRecords(STREAM, Array.from({ length: Math.min(BATCH, to - first) }, (_, i) => record(first + i)))
  }
  return to - from
}

async function readAll(backend: SqliteBackend) {
  let count = 0
  let after: string | undefined
  for (;;) {
    const page = await backend.readRecords({ stream: STREAM.StreamName, shardIx: 0, limit: 10000, ...(after ? { after } : {}) })
    if (!page.length) return count
    count += page.length
    after = page.at(-1)!.sequenceNumber
  }
}

async function expireBefore(backend: SqliteBackend, index: number) {
  let total = 0
  let expired
  do {
    expired = await backend.expireRecords(STREAM.StreamName, 0, CREATED / 1000 + index, BATCH)
    total += expired
  } while (expired === BATCH)
  return total
}

async function writeWhileExpiring(backend: SqliteBackend) {
  for (let first = RECORDS; first < 2 * RECORDS; first += BATCH) {
    await write(backend, first, first + BATCH)
    await expireBefore(backend, first - RECORDS + BATCH)
  }
  return RECORDS
}

const rows = []
for (const [name, reclaimSpace] of candidates) {
  const path = mkdtempSync(join(tmpdir(), 'kinesis-benchmark-'))
  const backend = new SqliteBackend(path, { reclaimSpace })
  try {
    const writes = await timed(() => write(backend, 0, RECORDS))
    const full = megabytes(path)
    const reads = await timed(() => readAll(backend))
    const steady = await timed(() => writeWhileExpiring(backend))
    const afterSteady = megabytes(path)
    const expiries = await timed(() => expireBefore(backend, 2 * RECORDS - RECORDS / 10))
    rows.push({
      Candidate: name,
      'Writes/s': writes,
      'Reads/s': reads,
      'Writes/s while expiring': steady,
      'Expiries/s': expiries,
      'MiB when full': full,
      'MiB after steady state': afterSteady,
      'MiB after 90% expire': megabytes(path),
    })
  } finally {
    backend.close()
    rmSync(path, { recursive: true, force: true })
  }
}

console.log(`${RECORDS} records of ${DATA.length} bytes in one shard, in batches of ${BATCH}`)
console.table(rows)
