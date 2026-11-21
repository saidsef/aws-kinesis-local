import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SqliteBackend } from '../../src/store/sqlite.ts'
import type { StorageBackend } from '../../src/store/types.ts'
import { storageBackendTests } from '../../src/testing.ts'
import { MapBackend } from '../backends/map.ts'

const backends: Record<string, () => StorageBackend & { close?(): void }> = {
  'SQLite in memory': () => new SqliteBackend(),
  'SQLite in a directory': () => new SqliteBackend(mkdtempSync(join(tmpdir(), 'kinesis-backend-'))),
  'Map objects': () => new MapBackend(),
}

for (const [name, create] of Object.entries(backends)) {
  describe(`storage backend on ${name}`, () => {
    for (const test of storageBackendTests) {
      it(test.name, async () => {
        const backend = create()
        try {
          await test.run(backend)
        } finally {
          backend.close?.()
        }
      })
    }
  })
}
