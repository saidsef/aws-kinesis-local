import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type ServerResponse } from 'node:http'
import { createServer as createHttp2Server, createSecureServer, type ServerHttp2Session } from 'node:http2'
import { createServer as createNetServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { selfSignedCertificate } from './certificate.ts'
import { ChannelDelivery } from './delivery/channel.ts'
import type { S3Client } from './delivery/s3.ts'
import { createHandler } from './handler.ts'
import { Logger, type LogLevel } from './logger.ts'
import { registerTransitions } from './operations/index.ts'
import { Store } from './store/store.ts'

export interface StartOptions {
  port: number
  host?: string | undefined
  path?: string | undefined
  ssl: boolean
  keyFile?: string | undefined
  certFile?: string | undefined
  createStreamMs: number
  deleteStreamMs: number
  updateStreamMs: number
  expiryIntervalMs: number
  shardLimit: number
  accountId: string
  region: string
  shutdownMs: number
  logLevel: LogLevel
  s3Endpoint?: string | undefined
  s3Region?: string | undefined
  s3AccessKeyId?: string | undefined
  s3SecretAccessKey?: string | undefined
  deliveryIntervalMs?: number | undefined
}

export interface KinesisLocal {
  endpoint: string
  address: AddressInfo
  protocol: 'http' | 'https'
  reset(stream?: string): string[]
  advanceClock(seconds: number): number
  close(): Promise<void>
}

const HTTP2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1')
const TLS_HANDSHAKE = 0x16
const S3_TIMEOUT_MS = 30000

export function defaultOptions(): StartOptions {
  return {
    port: 4567,
    ssl: false,
    createStreamMs: 500,
    deleteStreamMs: 500,
    updateStreamMs: 500,
    expiryIntervalMs: 60000,
    shardLimit: 10,
    accountId: (process.env.AWS_ACCOUNT_ID || '0000-0000-0000').replace(/[^\d]/g, ''),
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    shutdownMs: 5000,
    logLevel: 'warn',
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || undefined,
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || undefined,
  }
}

function s3Client(options: StartOptions): S3Client | undefined {
  if (!options.s3Endpoint) return undefined
  const protocol = URL.parse(options.s3Endpoint)?.protocol
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`The S3 endpoint ${options.s3Endpoint} is not an http or https URL.`)
  if (!options.s3AccessKeyId || !options.s3SecretAccessKey) {
    throw new Error('Delivery to the S3 endpoint needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY in the environment.')
  }
  if (options.deliveryIntervalMs !== undefined && !(options.deliveryIntervalMs > 0)) {
    throw new Error(`The delivery interval ${options.deliveryIntervalMs} is not a positive number of milliseconds.`)
  }
  return {
    endpoint: options.s3Endpoint,
    region: options.s3Region || options.region,
    credentials: { accessKeyId: options.s3AccessKeyId, secretAccessKey: options.s3SecretAccessKey },
    timeoutMs: S3_TIMEOUT_MS,
  }
}

interface Servers {
  http1: Server
  http2: Server
  tls: Server
}

function routeByProtocol(socket: Socket, servers: Servers) {
  let buffered = Buffer.alloc(0)
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    const isTls = buffered[0] === TLS_HANDSHAKE
    const length = Math.min(buffered.length, HTTP2_PREFACE.length)
    const isHttp2 = !isTls && buffered.subarray(0, length).equals(HTTP2_PREFACE.subarray(0, length))
    if (isHttp2 && buffered.length < HTTP2_PREFACE.length) return
    socket.off('data', onData)
    socket.pause()
    socket.unshift(buffered)
    if (isTls) {
      servers.tls.emit('connection', socket)
    } else if (isHttp2) {
      servers.http2.emit('connection', socket)
    } else {
      servers.http1.emit('connection', socket)
      socket.resume()
    }
  }
  socket.on('data', onData)
}

function hostname(address: AddressInfo) {
  if (address.address === '::' || address.address === '0.0.0.0') return 'localhost'
  return address.family === 'IPv6' ? `[${address.address}]` : address.address
}

export async function start(overrides: Partial<StartOptions> = {}): Promise<KinesisLocal> {
  const options = { ...defaultOptions(), ...overrides }
  const logger = new Logger(options.logLevel)
  const s3 = s3Client(options)
  const credentials = options.keyFile && options.certFile
    ? { key: readFileSync(options.keyFile), cert: readFileSync(options.certFile) }
    : selfSignedCertificate()
  const store = new Store(options, logger)
  registerTransitions(store)
  store.startExpiry()
  store.resume()
  const handle = createHandler(store, logger)
  const sockets = new Set<Socket>()
  const sessions = new Set<ServerHttp2Session>()
  let inFlight = 0
  let onIdle = () => {}
  const handler: typeof handle = (req, res) => {
    const response = res as ServerResponse
    inFlight++
    response.once('close', () => {
      inFlight--
      if (inFlight === 0) onIdle()
    })
    if (store.draining && req.httpVersionMajor < 2) response.setHeader('Connection', 'close')
    handle(req, res)
  }
  const trackSession = (session: ServerHttp2Session) => {
    sessions.add(session)
    session.once('close', () => sessions.delete(session))
  }
  const secure = createSecureServer({ ...credentials, allowHTTP1: true }, handler)
  secure.on('session', trackSession)
  let server: Server
  if (options.ssl) {
    server = secure as unknown as Server
  } else {
    const http2 = createHttp2Server(handler)
    http2.on('session', trackSession)
    const servers = { http1: createHttpServer(handler), http2: http2 as unknown as Server, tls: secure as unknown as Server }
    server = createNetServer(socket => {
      socket.on('error', () => socket.destroy())
      routeByProtocol(socket, servers)
    })
  }
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, options.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    store.close()
    throw error
  }
  const delivery = s3 && new ChannelDelivery(store, logger, s3, options.deliveryIntervalMs)
  delivery?.start()
  const address = server.address() as AddressInfo
  const protocol = options.ssl ? 'https' : 'http'
  const shutdown = async () => {
    store.drain()
    const stopped = new Promise<void>(resolve => server.close(() => resolve()))
    for (const session of sessions) session.close()
    const idle = new Promise<void>(resolve => {
      onIdle = resolve
      if (inFlight === 0) resolve()
    })
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all([idle, delivery?.stop()]),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, options.shutdownMs)
      }),
    ])
    clearTimeout(timer)
    store.close()
    for (const socket of sockets) socket.destroy()
    await stopped
  }
  let closing: Promise<void> | undefined
  return {
    endpoint: `${protocol}://${hostname(address)}:${address.port}`,
    address,
    protocol,
    reset: stream => store.reset(stream),
    advanceClock: seconds => store.advanceClock(seconds),
    close: () => closing ??= shutdown(),
  }
}
