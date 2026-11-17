import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import {
  CreateStreamCommand, DescribeStreamConsumerCommand, DescribeStreamSummaryCommand, ListStreamsCommand, RegisterStreamConsumerCommand,
  SubscribeToShardCommand, type KinesisClient,
} from '@aws-sdk/client-kinesis'
import { kinesis, rejects, unique, waitFor } from './helpers.ts'
import { call, send } from './http.ts'

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))

interface Cli {
  endpoint: string
  child: ChildProcess
  lines(): Record<string, any>[]
}

let running: Cli | undefined
let client: KinesisClient | undefined

afterEach(async () => {
  client?.destroy()
  client = undefined
  if (running && running.child.exitCode === null) {
    running.child.kill('SIGTERM')
    await once(running.child, 'exit')
  }
  running = undefined
})

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

async function startCli(...args: string[]) {
  const port = await freePort()
  const child = spawn(process.execPath, [CLI, '--port', String(port), '--createStreamMs', '20', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  const lines = () => stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, any>)
  running = { endpoint: `http://127.0.0.1:${port}`, child, lines }
  await waitFor(async () => stdout, output => output.includes('Listening at'))
  client = kinesis(running.endpoint)
  return running
}

async function lineFor(cli: Cli, requestId: string | undefined) {
  return (await waitFor(async () => cli.lines().find(line => line.requestId === requestId), line => line !== undefined))!
}

async function activeStream(name: string) {
  await client!.send(new CreateStreamCommand({ StreamName: name, ShardCount: 1 }))
  const summary = await waitFor(
    () => client!.send(new DescribeStreamSummaryCommand({ StreamName: name })),
    result => result.StreamDescriptionSummary?.StreamStatus === 'ACTIVE',
  )
  return summary.StreamDescriptionSummary!.StreamARN!
}

describe('logging', () => {
  it('writes a line for every API request at the info level, with its request ID', async () => {
    const cli = await startCli('--logLevel', 'info')
    const name = unique('logged')
    const { $metadata } = await client!.send(new CreateStreamCommand({ StreamName: name, ShardCount: 1 }))
    const line = await lineFor(cli, $metadata.requestId)
    assert.equal(line.level, 'info')
    assert.equal(line.operation, 'CreateStream')
    assert.equal(line.stream, name)
    assert.equal(line.status, 200)
    assert.equal(typeof line.durationMs, 'number')
    assert.ok(!Number.isNaN(Date.parse(line.time)))
    assert.equal(line.request, undefined)
    assert.equal(line.response, undefined)
    const health = await send(cli.endpoint, { method: 'GET', path: '/healthz' })
    await lineFor(cli, (await client!.send(new ListStreamsCommand({}))).$metadata.requestId)
    assert.equal(cli.lines().some(entry => entry.requestId === health.headers['x-amzn-requestid']), false)
  })

  it('logs only rejected requests, with their error type, at the default warn level', async () => {
    const cli = await startCli()
    const listed = await client!.send(new ListStreamsCommand({}))
    const missing = await call(cli.endpoint, 'DescribeStream', { StreamName: 'missing' })
    const line = await lineFor(cli, missing.headers['x-amzn-requestid'])
    assert.equal(line.level, 'warn')
    assert.equal(line.operation, 'DescribeStream')
    assert.equal(line.stream, 'missing')
    assert.equal(line.status, 400)
    assert.equal(line.errorType, 'ResourceNotFoundException')
    assert.match(line.errorMessage, /missing/)
    const denied = await send(cli.endpoint, { method: 'GET', path: '/?X-Amz-Signature=secret' })
    const deniedLine = await lineFor(cli, denied.headers['x-amzn-requestid'])
    assert.equal(deniedLine.errorType, 'AccessDeniedException')
    assert.equal(deniedLine.path, '/')
    assert.equal(JSON.stringify(cli.lines()).includes('secret'), false)
    assert.equal(cli.lines().some(entry => entry.requestId === listed.$metadata.requestId), false)
  })

  it('logs health checks at the debug level', async () => {
    const cli = await startCli('--logLevel', 'debug')
    const health = await send(cli.endpoint, { method: 'GET', path: '/healthz' })
    const line = await lineFor(cli, health.headers['x-amzn-requestid'])
    assert.equal(line.level, 'debug')
    assert.equal(line.path, '/healthz')
    assert.equal(line.status, 200)
    assert.equal(line.response, undefined)
  })

  it('adds request and response bodies at the trace level', async () => {
    const cli = await startCli('--logLevel', 'trace')
    const listed = await call(cli.endpoint, 'ListStreams', { Limit: 5 })
    const line = await lineFor(cli, listed.headers['x-amzn-requestid'])
    assert.deepEqual(line.request, { Limit: 5 })
    assert.deepEqual(line.response, JSON.parse(listed.body.toString('utf8')))
    const cbor = await call(cli.endpoint, 'PutRecord', { StreamName: 'missing', PartitionKey: 'p', Data: new TextEncoder().encode('cbor') }, { protocol: 'cbor' })
    const cborLine = await lineFor(cli, cbor.headers['x-amzn-requestid'])
    assert.equal(cborLine.request.Data, Buffer.from('cbor').toString('base64'))
    assert.equal(cborLine.response.__type, 'ResourceNotFoundException')
    const malformed = await send(cli.endpoint, {
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Kinesis_20131202.ListStreams' },
      body: 'not json',
    })
    const malformedLine = await lineFor(cli, malformed.headers['x-amzn-requestid'])
    assert.equal(malformedLine.request, 'not json')
    assert.equal(malformedLine.errorType, 'SerializationException')
  })

  it('records the exception that ends a SubscribeToShard stream', async () => {
    const cli = await startCli('--logLevel', 'info')
    const name = unique('subscribed')
    const { Consumer } = await client!.send(new RegisterStreamConsumerCommand({ StreamARN: await activeStream(name), ConsumerName: 'reader' }))
    await waitFor(
      () => client!.send(new DescribeStreamConsumerCommand({ ConsumerARN: Consumer!.ConsumerARN })),
      result => result.ConsumerDescription?.ConsumerStatus === 'ACTIVE',
    )
    const subscription = await client!.send(new SubscribeToShardCommand({
      ConsumerARN: Consumer!.ConsumerARN,
      ShardId: 'shardId-000000000000',
      StartingPosition: { Type: 'TRIM_HORIZON' },
    }))
    const events = subscription.EventStream![Symbol.asyncIterator]()
    assert.ok((await events.next()).value?.SubscribeToShardEvent)
    await send(cli.endpoint, { path: '/_control/reset', body: JSON.stringify({ stream: name }) })
    await rejects(events.next(), 'ResourceNotFoundException')
    const line = await lineFor(cli, subscription.$metadata.requestId)
    assert.equal(line.level, 'warn')
    assert.equal(line.operation, 'SubscribeToShard')
    assert.equal(line.stream, name)
    assert.equal(line.status, 200)
    assert.equal(line.errorType, 'ResourceNotFoundException')
  })

  it('refuses an unknown log level', async () => {
    const child = spawn(process.execPath, [CLI, '--port', String(await freePort()), '--logLevel', 'verbose'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    const [code] = await once(child, 'exit')
    assert.equal(code, 1)
    assert.match(stderr, /Unknown log level verbose/)
  })
})
