import { KinesisClient } from '@aws-sdk/client-kinesis'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { setTimeout as sleep } from 'node:timers/promises'
import { start, type KinesisLocal, type StartOptions } from '../../src/index.ts'

export interface Target {
  endpoint: string
  server?: KinesisLocal
  close(): Promise<void>
}

export async function startTarget(options: Partial<StartOptions> = {}): Promise<Target> {
  const external = process.env.KINESIS_ENDPOINT
  if (external && !options.path && !options.ssl) return { endpoint: external, close: async () => {} }
  const server = await start({
    port: 0,
    host: '127.0.0.1',
    ssl: false,
    createStreamMs: 20,
    deleteStreamMs: 20,
    updateStreamMs: 20,
    shardLimit: 200,
    accountId: '000000000000',
    region: 'eu-west-1',
    logLevel: 'error',
    ...options,
  })
  return {
    endpoint: `${server.protocol}://127.0.0.1:${server.address.port}`,
    server,
    close: () => server.close(),
  }
}

export function kinesis(endpoint: string, transport: 'http2' | 'http1' = 'http2') {
  return new KinesisClient({
    endpoint,
    region: 'eu-west-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
    ...(transport === 'http1' ? { requestHandler: new NodeHttpHandler() } : {}),
  })
}

export function unique(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms: ${JSON.stringify(value)}`)
    await sleep(25)
  }
}

export function text(bytes: Uint8Array | undefined) {
  return Buffer.from(bytes ?? new Uint8Array()).toString('utf8')
}

export async function rejects(promise: Promise<unknown>, name: string, message?: RegExp) {
  try {
    await promise
  } catch (error) {
    const failure = error as { name?: string, message?: string }
    if (failure.name !== name) throw new Error(`Expected ${name} but got ${failure.name}: ${failure.message}`)
    if (message && !message.test(failure.message ?? '')) throw new Error(`Unexpected message for ${name}: ${failure.message}`)
    return failure
  }
  throw new Error(`Expected ${name} but the call succeeded`)
}
