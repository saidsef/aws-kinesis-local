import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttp2Server, createSecureServer } from 'node:http2'
import { createServer as createNetServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { selfSignedCertificate } from './certificate.ts'
import { createHandler } from './handler.ts'
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
  shardLimit: number
  accountId: string
  region: string
}

export interface KinesisLocal {
  endpoint: string
  address: AddressInfo
  protocol: 'http' | 'https'
  close(): Promise<void>
}

const HTTP2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1')

export function defaultOptions(): StartOptions {
  return {
    port: 4567,
    ssl: false,
    createStreamMs: 500,
    deleteStreamMs: 500,
    updateStreamMs: 500,
    shardLimit: 10,
    accountId: (process.env.AWS_ACCOUNT_ID || '0000-0000-0000').replace(/[^\d]/g, ''),
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
  }
}

function routeByProtocol(socket: Socket, http1: Server, http2: Server) {
  let buffered = Buffer.alloc(0)
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    const length = Math.min(buffered.length, HTTP2_PREFACE.length)
    const isHttp2 = buffered.subarray(0, length).equals(HTTP2_PREFACE.subarray(0, length))
    if (isHttp2 && buffered.length < HTTP2_PREFACE.length) return
    socket.off('data', onData)
    socket.pause()
    socket.unshift(buffered)
    if (isHttp2) {
      http2.emit('connection', socket)
    } else {
      http1.emit('connection', socket)
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
  const store = new Store(options)
  registerTransitions(store)
  store.resume()
  const handler = createHandler(store)
  const sockets = new Set<Socket>()
  let server: Server
  if (options.ssl) {
    const credentials = options.keyFile && options.certFile
      ? { key: readFileSync(options.keyFile), cert: readFileSync(options.certFile) }
      : selfSignedCertificate()
    server = createSecureServer({ ...credentials, allowHTTP1: true }, handler) as unknown as Server
  } else {
    const http1 = createHttpServer(handler)
    const http2 = createHttp2Server(handler)
    server = createNetServer(socket => {
      socket.on('error', () => socket.destroy())
      routeByProtocol(socket, http1, http2 as unknown as Server)
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
  const address = server.address() as AddressInfo
  const protocol = options.ssl ? 'https' : 'http'
  return {
    endpoint: `${protocol}://${hostname(address)}:${address.port}`,
    address,
    protocol,
    close: () => new Promise<void>(resolve => {
      store.close()
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}
