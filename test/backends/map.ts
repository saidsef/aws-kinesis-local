import type { DocumentKind, RecordQuery, StorageBackend, StoredDocument, StoredRecord, StreamDoc } from '../../src/index.ts'

export class MapBackend implements StorageBackend {
  readonly documents = new Map<DocumentKind, Map<string, StoredDocument>>()
  readonly records = new Map<string, Map<number, Map<string, StoredRecord>>>()
  readonly positions = new Map<string, Map<string, Map<number, string>>>()

  async readDocuments() {
    return [...this.documents.values()].flatMap(documents => [...documents.values()]).map(document => structuredClone(document))
  }

  async putDocument(document: StoredDocument) {
    let documents = this.documents.get(document.kind)
    if (!documents) this.documents.set(document.kind, documents = new Map())
    documents.set(document.key, structuredClone(document))
  }

  async deleteDocument(kind: DocumentKind, key: string) {
    this.documents.get(kind)?.delete(key)
  }

  private shard(stream: string, shardIx: number) {
    let shards = this.records.get(stream)
    if (!shards) this.records.set(stream, shards = new Map())
    let shard = shards.get(shardIx)
    if (!shard) shards.set(shardIx, shard = new Map())
    return shard
  }

  private inOrder(stream: string, shardIx: number) {
    const shard = this.records.get(stream)?.get(shardIx)
    return [...shard?.values() ?? []].sort((a, b) => (a.sequenceNumber < b.sequenceNumber ? -1 : 1))
  }

  async putRecords(stream: StreamDoc, records: StoredRecord[]) {
    await this.putDocument({ kind: 'stream', key: stream.StreamName, value: stream })
    for (const record of records) this.shard(stream.StreamName, record.shardIx).set(record.sequenceNumber, { ...record, data: Buffer.from(record.data) })
  }

  async readRecords(query: RecordQuery) {
    return this.inOrder(query.stream, query.shardIx)
      .filter(record => (query.from === undefined || record.sequenceNumber >= query.from)
        && (query.after === undefined || record.sequenceNumber > query.after)
        && (query.arrivedSince === undefined || record.arrival >= query.arrivedSince))
      .slice(0, query.limit)
  }

  async expireRecords(stream: string, shardIx: number, arrivedBefore: number, limit: number) {
    const expired: string[] = []
    for (const record of this.inOrder(stream, shardIx)) {
      if (expired.length === limit || record.arrival >= arrivedBefore) break
      expired.push(record.sequenceNumber)
    }
    for (const sequenceNumber of expired) this.shard(stream, shardIx).delete(sequenceNumber)
    return expired.length
  }

  async deleteRecords(stream: string) {
    this.records.delete(stream)
  }

  async readDeliveryPositions(channelId: string, stream: string) {
    return new Map(this.positions.get(channelId)?.get(stream))
  }

  async putDeliveryPositions(channelId: string, stream: string, positions: Map<number, string>) {
    let streams = this.positions.get(channelId)
    if (!streams) this.positions.set(channelId, streams = new Map())
    streams.set(stream, new Map([...streams.get(stream) ?? [], ...positions]))
  }

  async deleteDeliveryPositions(channelId: string) {
    this.positions.delete(channelId)
  }

  async ping() {}
}
