import { EventEmitter } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type { Logger } from '../logger.ts'
import type {
  AccountSettings, ChannelDoc, ConsumerDoc, DocumentKind, Pending, RecordQuery, StorageBackend, StoredDocument, StoredRecord, StreamDoc,
} from './types.ts'

export const MAX_CLOCK_ADVANCE_SECONDS = 10 * 365 * 24 * 60 * 60
const EXPIRY_BATCH_SIZE = 500
const SETTINGS_KEY = 'account'
const CLOCK_KEY = 'offset'

const defaultSettings = (): AccountSettings => ({ MinimumThroughputBillingCommitment: { Status: 'DISABLED' } })

export interface StoreOptions {
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
export type Transition = (store: Store, key: string, data: unknown) => Promise<unknown> | void
export type ReadRecord = Omit<StoredRecord, 'data'> & { data: Buffer }

export function validClockAdvance(seconds: unknown): seconds is number {
  return typeof seconds === 'number' && seconds >= 0 && seconds <= MAX_CLOCK_ADVANCE_SECONDS
}

function streamQueue(name: string) {
  return `stream:${name}`
}

function channelQueue(arn: string) {
  return `channel:${arn}`
}

function buffer(data: Uint8Array) {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

function closedError() {
  return new Error('The store is closed.')
}

export class Store {
  readonly options: StoreOptions
  private readonly logger: Logger
  private readonly backend: StorageBackend
  readonly streams = new Map<string, StreamDoc>()
  readonly consumers = new Map<string, ConsumerDoc>()
  readonly channels = new Map<string, ChannelDoc>()
  readonly policies = new Map<string, string>()
  readonly events = new EventEmitter()
  settings: AccountSettings = defaultSettings()
  draining = false
  private readonly transitions = new Map<string, Transition>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly queues = new Map<string, Promise<void>>()
  private offsetMs = 0
  private closed = false

  constructor(options: StoreOptions, logger: Logger, backend: StorageBackend) {
    this.options = options
    this.logger = logger
    this.backend = backend
    this.events.setMaxListeners(0)
  }

  async load() {
    for (const document of await this.backend.readDocuments()) {
      const { kind, key } = document
      const value = structuredClone(document.value)
      if (kind === 'stream') this.streams.set(key, value as StreamDoc)
      else if (kind === 'consumer') this.consumers.set(key, value as ConsumerDoc)
      else if (kind === 'channel') this.channels.set(key, value as ChannelDoc)
      else if (kind === 'policy') this.policies.set(key, value as string)
      else if (kind === 'settings') this.settings = value as AccountSettings
      else if (kind === 'clock') this.offsetMs = Number(value)
    }
  }

  private serial<T>(queue: string, work: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(queue) ?? Promise.resolve()).then(work)
    const tail = result.then(() => {}, () => {})
    this.queues.set(queue, tail)
    void tail.then(() => {
      if (this.queues.get(queue) === tail) this.queues.delete(queue)
    })
    return result
  }

  private logError(message: string, error: unknown) {
    this.logger.log('error', { message, error: error instanceof Error ? error.stack : error })
  }

  now() {
    return Date.now() + this.offsetMs
  }

  async advanceClock(seconds: number) {
    if (!validClockAdvance(seconds)) throw new RangeError(`The clock moves forward by a number of seconds from 0 to ${MAX_CLOCK_ADVANCE_SECONDS}.`)
    this.offsetMs += Math.round(seconds * 1000)
    const writes = [this.saveOffset()]
    for (;;) {
      const next = this.pendingDocs().filter(entry => entry.pending.due <= this.now()).sort((a, b) => a.pending.due - b.pending.due)[0]
      if (!next || this.closed) break
      this.cancel(next.kind, next.key)
      writes.push(this.fire(next.kind, next.key))
    }
    this.resume()
    this.events.emit('clock')
    const offset = this.offsetMs / 1000
    await Promise.all(writes)
    return offset
  }

  private saveOffset() {
    if (this.offsetMs) return this.put('clock', { kind: 'clock', key: CLOCK_KEY, value: this.offsetMs })
    return this.erase('clock', 'clock', CLOCK_KEY)
  }

  private collection(kind: Kind): Map<string, Doc> {
    return (kind === 'stream' ? this.streams : kind === 'consumer' ? this.consumers : this.channels) as Map<string, Doc>
  }

  private put(queue: string, document: StoredDocument) {
    if (this.closed) return Promise.resolve()
    const copy = structuredClone(document)
    return this.serial(queue, () => this.backend.putDocument(copy))
  }

  private erase(queue: string, kind: DocumentKind, key: string) {
    if (this.closed) return Promise.resolve()
    return this.serial(queue, () => this.backend.deleteDocument(kind, key))
  }

  saveStream(doc: StreamDoc) {
    this.streams.set(doc.StreamName, doc)
    return this.put(streamQueue(doc.StreamName), { kind: 'stream', key: doc.StreamName, value: doc })
  }

  async removeStream(name: string) {
    this.cancel('stream', name)
    this.streams.delete(name)
    await Promise.all([this.erase(streamQueue(name), 'stream', name), this.deleteStreamRecords(name)])
  }

  saveConsumer(doc: ConsumerDoc) {
    this.consumers.set(doc.ConsumerARN, doc)
    return this.put(streamQueue(doc.StreamName), { kind: 'consumer', key: doc.ConsumerARN, value: doc })
  }

  async removeConsumer(arn: string) {
    const consumer = this.consumers.get(arn)
    if (!consumer) return
    this.cancel('consumer', arn)
    this.consumers.delete(arn)
    const writes = [this.erase(streamQueue(consumer.StreamName), 'consumer', arn), this.removePolicy(arn)]
    this.events.emit('consumer-removed', arn)
    await Promise.all(writes)
  }

  saveChannel(doc: ChannelDoc) {
    this.channels.set(doc.ChannelARN, doc)
    return this.put(channelQueue(doc.ChannelARN), { kind: 'channel', key: doc.ChannelARN, value: doc })
  }

  async removeChannel(arn: string) {
    const channel = this.channels.get(arn)
    if (!channel) return
    this.cancel('channel', arn)
    this.channels.delete(arn)
    const writes = [this.erase(channelQueue(arn), 'channel', arn), this.removePolicy(arn)]
    if (!this.closed) writes.push(this.serial(channelQueue(arn), () => this.backend.deleteDeliveryPositions(channel.ChannelId)))
    this.events.emit('channel-removed', arn)
    await Promise.all(writes)
  }

  savePolicy(arn: string, policy: string) {
    this.policies.set(arn, policy)
    return this.put(`policy:${arn}`, { kind: 'policy', key: arn, value: policy })
  }

  removePolicy(arn: string) {
    if (!this.policies.delete(arn)) return Promise.resolve()
    return this.erase(`policy:${arn}`, 'policy', arn)
  }

  saveSettings(settings: AccountSettings) {
    this.settings = settings
    return this.put('settings', { kind: 'settings', key: SETTINGS_KEY, value: settings })
  }

  async reset(name?: string) {
    const names = name === undefined ? [...this.streams.keys()].sort() : this.streams.has(name) ? [name] : []
    const arns = new Set(names.map(stream => this.streams.get(stream)!.StreamARN))
    const consumers = [...this.consumers.values()].filter(consumer => names.includes(consumer.StreamName))
    const channels = [...this.channels.values()].filter(channel =>
      name === undefined || channel.StreamConfigurationList.some(entry => arns.has(entry.StreamARN as string)))
    const writes: Promise<unknown>[] = []
    for (const stream of names) {
      this.events.emit('stream-deleted', stream)
      writes.push(this.removePolicy(this.streams.get(stream)!.StreamARN), this.removeStream(stream))
    }
    for (const consumer of consumers) writes.push(this.removeConsumer(consumer.ConsumerARN))
    for (const channel of channels) writes.push(this.removeChannel(channel.ChannelARN))
    if (name === undefined) {
      for (const arn of [...this.policies.keys()]) writes.push(this.removePolicy(arn))
      this.settings = defaultSettings()
      writes.push(this.erase('settings', 'settings', SETTINGS_KEY))
      this.offsetMs = 0
      writes.push(this.saveOffset())
    }
    await Promise.all(writes)
    return names
  }

  putRecords(stream: StreamDoc, records: StoredRecord[]) {
    if (this.closed) return Promise.reject(closedError())
    const copy = structuredClone(stream)
    return this.serial(streamQueue(stream.StreamName), () => this.backend.putRecords(copy, records))
  }

  async readRecords(query: RecordQuery): Promise<ReadRecord[]> {
    if (this.closed) throw closedError()
    const records = await this.serial(streamQueue(query.stream), () => this.backend.readRecords({ ...query }))
    return records.map(record => ({ ...record, data: buffer(record.data) }))
  }

  async firstSequenceAtOrAfter(stream: string, shardIx: number, timestamp: number) {
    return (await this.readRecords({ stream, shardIx, arrivedSince: timestamp, limit: 1 }))[0]?.sequenceNumber
  }

  deleteStreamRecords(stream: string) {
    if (this.closed) return Promise.resolve()
    return this.serial(streamQueue(stream), () => this.backend.deleteRecords(stream))
  }

  expireRecords(stream: string, shardIx: number, cutoff: number) {
    if (this.closed) return Promise.resolve(0)
    const arrivedBefore = Math.ceil(cutoff / 1000)
    return this.serial(streamQueue(stream), () => this.backend.expireRecords(stream, shardIx, arrivedBefore, EXPIRY_BATCH_SIZE))
  }

  expireLater(stream: string, shardIx: number, cutoff: number) {
    this.expireRecords(stream, shardIx, cutoff).catch(error => this.logError('Record expiry failed', error))
  }

  async deliveryPositions(channel: ChannelDoc, stream: string) {
    if (this.closed) throw closedError()
    return this.serial(channelQueue(channel.ChannelARN), () => this.backend.readDeliveryPositions(channel.ChannelId, stream))
  }

  saveDeliveryPositions(channel: ChannelDoc, stream: string, positions: Map<number, string>) {
    if (this.closed) return Promise.resolve()
    const copy = new Map(positions)
    return this.serial(channelQueue(channel.ChannelARN), () => this.backend.putDeliveryPositions(channel.ChannelId, stream, copy))
  }

  startExpiry() {
    const run = async () => {
      try {
        await this.expireAll()
      } catch (error) {
        this.logError('Record expiry failed', error)
      }
      if (!this.closed) this.timers.set('expiry', setTimeout(run, this.options.expiryIntervalMs))
    }
    this.timers.set('expiry', setTimeout(run, 0))
  }

  private async expireAll() {
    for (const stream of [...this.streams.values()]) {
      for (let shardIx = 0; shardIx < stream.Shards.length && !this.closed; shardIx++) {
        let expired
        do {
          expired = await this.expireRecords(stream.StreamName, shardIx, this.now() - stream.RetentionPeriodHours * 60 * 60 * 1000)
          await nextTurn()
        } while (expired === EXPIRY_BATCH_SIZE && !this.closed)
      }
    }
  }

  registerTransition(action: string, transition: Transition) {
    this.transitions.set(action, transition)
  }

  schedule(kind: 'stream', doc: StreamDoc, action: string, delayMs: number, data?: unknown): Promise<void>
  schedule(kind: 'consumer', doc: ConsumerDoc, action: string, delayMs: number, data?: unknown): Promise<void>
  schedule(kind: 'channel', doc: ChannelDoc, action: string, delayMs: number, data?: unknown): Promise<void>
  schedule(kind: Kind, doc: Doc, action: string, delayMs: number, data?: unknown) {
    const pending: Pending = { action, due: this.now() + delayMs }
    if (data !== undefined) pending.data = data
    doc._pending = pending
    const saved = this.persist(kind, doc)
    this.arm(kind, this.keyOf(kind, doc), pending)
    return saved
  }

  private keyOf(kind: Kind, doc: Doc) {
    if (kind === 'stream') return (doc as StreamDoc).StreamName
    if (kind === 'consumer') return (doc as ConsumerDoc).ConsumerARN
    return (doc as ChannelDoc).ChannelARN
  }

  private persist(kind: Kind, doc: Doc) {
    if (kind === 'stream') return this.saveStream(doc as StreamDoc)
    if (kind === 'consumer') return this.saveConsumer(doc as ConsumerDoc)
    return this.saveChannel(doc as ChannelDoc)
  }

  private arm(kind: Kind, key: string, pending: Pending) {
    const id = `${kind}:${key}`
    clearTimeout(this.timers.get(id))
    const timer = setTimeout(() => {
      this.timers.delete(id)
      this.fire(kind, key).catch(error => this.logError('State transition failed', error))
    }, Math.max(0, pending.due - this.now()))
    this.timers.set(id, timer)
  }

  private async fire(kind: Kind, key: string) {
    if (this.closed) return
    const doc = this.collection(kind).get(key)
    const pending = doc?._pending
    if (!doc || !pending) return
    delete doc._pending
    const transition = this.transitions.get(pending.action)
    if (!transition) throw new Error(`No transition registered for ${pending.action}`)
    const changed = transition(this, key, pending.data)
    const current = this.collection(kind).get(key)
    const saved = current === doc && !doc._pending ? this.persist(kind, doc) : undefined
    await Promise.all([changed, saved])
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

  async healthy() {
    if (this.closed) return false
    try {
      await this.backend.ping()
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

  async close() {
    if (this.closed) return
    this.drain()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.closed = true
    await Promise.all(this.queues.values())
  }
}
