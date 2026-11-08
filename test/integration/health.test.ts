import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Agent, request } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { AMZ_JSON, AUTH, call, parseBody, send } from './http.ts'
import { startTarget, waitFor } from './helpers.ts'

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))

function heldRequest(endpoint: string, operation: string, payload: unknown) {
  const body = JSON.stringify(payload)
  const req = request(new URL('/', endpoint), {
    method: 'POST',
    agent: false,
    headers: { 'content-type': AMZ_JSON, 'x-amz-target': `Kinesis_20131202.${operation}`, 'content-length': body.length, ...AUTH },
  })
  const status = new Promise<number>((resolve, reject) => {
    req.on('response', res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
  })
  req.write(body.slice(0, -1))
  return { status, finish: () => req.end(body.slice(-1)) }
}

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  server.close()
  await once(server, 'close')
  return port
}

async function createActive(endpoint: string, name: string) {
  await call(endpoint, 'CreateStream', { StreamName: name, ShardCount: 1 })
  await waitFor(
    () => call(endpoint, 'DescribeStreamSummary', { StreamName: name }).then(response => parseBody(response) as any),
    body => body.StreamDescriptionSummary?.StreamStatus === 'ACTIVE',
  )
}

function get(endpoint: string, path: string, agent?: Agent) {
  return send(endpoint, { method: 'GET', path, ...(agent ? { agent } : {}) })
}

const PUT = { StreamName: 'held', PartitionKey: 'p', Data: Buffer.from('held').toString('base64') }

describe('health endpoints', () => {
  it('answers 200 on /healthz and /readyz', async () => {
    const target = await startTarget()
    try {
      for (const path of ['/healthz', '/readyz', '/healthz?verbose=1']) {
        const response = await get(target.endpoint, path)
        assert.equal(response.status, 200, path)
        assert.equal(response.body.toString(), 'ok\n')
      }
    } finally {
      await target.close()
    }
  })

  it('keeps the 403 response for every other GET request', async () => {
    const target = await startTarget()
    try {
      for (const path of ['/', '/health', '/healthz/', '/readyz/live']) {
        const response = await get(target.endpoint, path)
        assert.equal(response.status, 403, path)
        assert.match(response.body.toString(), /<AccessDeniedException>/)
      }
    } finally {
      await target.close()
    }
  })
})

describe('shutdown', () => {
  it('fails /readyz and finishes a request in progress when SIGTERM arrives', async () => {
    const port = await freePort()
    const child = spawn(process.execPath, [CLI, '--port', String(port), '--createStreamMs', '10'], { stdio: ['ignore', 'pipe', 'inherit'] })
    await once(child.stdout, 'data')
    const endpoint = `http://127.0.0.1:${port}`
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      await createActive(endpoint, 'held')
      assert.equal((await get(endpoint, '/readyz', agent)).status, 200)
      const held = heldRequest(endpoint, 'PutRecord', PUT)
      await sleep(100)
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await sleep(100)
      const readiness = await get(endpoint, '/readyz', agent)
      assert.equal(readiness.status, 503)
      assert.equal(readiness.headers.connection, 'close')
      await assert.rejects(get(endpoint, '/healthz', new Agent()), /ECONNREFUSED/)
      held.finish()
      assert.equal(await held.status, 200)
      assert.deepEqual(await exited, [0, null])
    } finally {
      agent.destroy()
      child.kill('SIGKILL')
    }
  })

  it('ends a subscription cleanly', async () => {
    const target = await startTarget()
    await createActive(target.endpoint, 'subscribed')
    const summary = parseBody(await call(target.endpoint, 'DescribeStreamSummary', { StreamName: 'subscribed' })) as any
    const registered = parseBody(await call(target.endpoint, 'RegisterStreamConsumer', { StreamARN: summary.StreamDescriptionSummary.StreamARN, ConsumerName: 'reader' })) as any
    const consumerArn = registered.Consumer.ConsumerARN
    await waitFor(
      () => call(target.endpoint, 'DescribeStreamConsumer', { ConsumerARN: consumerArn }).then(response => parseBody(response) as any),
      body => body.ConsumerDescription?.ConsumerStatus === 'ACTIVE',
    )
    const subscription = call(target.endpoint, 'SubscribeToShard', { ConsumerARN: consumerArn, ShardId: 'shardId-000000000000', StartingPosition: { Type: 'TRIM_HORIZON' } })
    await sleep(100)
    const started = Date.now()
    await target.close()
    const response = await subscription
    assert.equal(response.status, 200)
    assert.match(response.body.toString('latin1'), /initial-response/)
    assert.ok(Date.now() - started < 2000)
  })

  it('gives up on a stuck request after the time limit', async () => {
    const target = await startTarget({ shutdownMs: 50 })
    const held = heldRequest(target.endpoint, 'ListStreams', {})
    const failure = assert.rejects(held.status)
    await sleep(100)
    const started = Date.now()
    await target.close()
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 40 && elapsed < 2000, `close took ${elapsed} ms`)
    await failure
  })
})
