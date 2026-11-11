import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { connect } from 'node:http2'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { after, before, describe, it } from 'node:test'
import { EventStreamCodec } from '@smithy/eventstream-codec'
import { decode, encode, Tag } from 'cbor2'
import { selfSignedCertificate } from '../../src/certificate.ts'
import { AMZ_CBOR, AUTH, call, parseBody, send } from './http.ts'
import { startTarget, unique, waitFor, type Target } from './helpers.ts'

let target: Target

before(async () => {
  target = await startTarget()
})

after(async () => {
  await target.close()
})

async function json(operation: string, body: unknown) {
  const response = await call(target.endpoint, operation, body)
  return { status: response.status, body: parseBody(response) as any }
}

async function createActive(name: string, shards = 1) {
  await json('CreateStream', { StreamName: name, ShardCount: shards })
  await waitFor(() => json('DescribeStreamSummary', { StreamName: name }), result => result.body.StreamDescriptionSummary?.StreamStatus === 'ACTIVE')
}

function javaStyleCbor(entries: [string, unknown][]) {
  const parts: Buffer[] = [Buffer.from([0xbf])]
  for (const [key, value] of entries) {
    parts.push(Buffer.from(encode(key)), Buffer.from(encode(value)))
  }
  parts.push(Buffer.from([0xff]))
  return Buffer.concat(parts)
}

async function cbor(operation: string, body: Buffer) {
  const response = await send(target.endpoint, {
    headers: { 'content-type': AMZ_CBOR, 'x-amz-target': `Kinesis_20131202.${operation}`, ...AUTH },
    body,
  })
  return { status: response.status, type: response.headers['content-type'], body: decode(new Uint8Array(response.body)) as any }
}

describe('CBOR', () => {
  it('accepts Jackson-style requests and returns byte strings and epoch milliseconds', async () => {
    const name = unique('cbor')
    await createActive(name)
    const put = await cbor('PutRecord', javaStyleCbor([['StreamName', name], ['PartitionKey', 'p'], ['Data', new Uint8Array([0, 1, 2, 255])]]))
    assert.equal(put.status, 200)
    assert.equal(put.type, AMZ_CBOR)
    const before = Date.now() - 60000
    const iterator = await cbor('GetShardIterator', javaStyleCbor([
      ['StreamName', name], ['ShardId', 'shardId-000000000000'], ['ShardIteratorType', 'AT_TIMESTAMP'], ['Timestamp', new Tag(1, before)],
    ]))
    assert.equal(iterator.status, 200)
    const records = await cbor('GetRecords', javaStyleCbor([['ShardIterator', iterator.body.ShardIterator]]))
    const [record] = records.body.Records
    assert.deepEqual(Buffer.from(record.Data), Buffer.from([0, 1, 2, 255]))
    assert.ok(Number.isInteger(record.ApproximateArrivalTimestamp))
    assert.ok(Math.abs(record.ApproximateArrivalTimestamp - Date.now()) < 60000)
    const summary = await cbor('DescribeStreamSummary', javaStyleCbor([['StreamName', name]]))
    assert.ok(Math.abs(summary.body.StreamDescriptionSummary.StreamCreationTimestamp - Date.now()) < 60000)
  })

  it('returns errors in CBOR', async () => {
    const response = await cbor('DescribeStream', javaStyleCbor([['StreamName', unique('missing')]]))
    assert.equal(response.status, 400)
    assert.equal(response.body.__type, 'ResourceNotFoundException')
  })
})

describe('HTTP/2', () => {
  it('serves cleartext HTTP/2 and HTTP/1.1 on the same port', async () => {
    const session = connect(target.endpoint)
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const stream = session.request({
          ':method': 'POST', ':path': '/', 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Kinesis_20131202.ListStreams', ...AUTH,
        })
        let text = ''
        stream.on('data', chunk => { text += chunk })
        stream.on('end', () => resolve(text))
        stream.on('error', reject)
        stream.end('{}')
      })
      assert.ok(Array.isArray(JSON.parse(body).StreamNames))
    } finally {
      await new Promise(resolve => session.close(() => resolve(undefined)))
    }
    assert.equal((await json('ListStreams', {})).status, 200)
  })

  it('streams SubscribeToShard events in CBOR for CBOR clients', async () => {
    const name = unique('cbor-subscribe')
    await createActive(name)
    const { body: summary } = await json('DescribeStreamSummary', { StreamName: name })
    const { body: registered } = await json('RegisterStreamConsumer', { StreamARN: summary.StreamDescriptionSummary.StreamARN, ConsumerName: 'java' })
    const consumerArn = registered.Consumer.ConsumerARN
    await waitFor(() => json('DescribeStreamConsumer', { ConsumerARN: consumerArn }), result => result.body.ConsumerDescription?.ConsumerStatus === 'ACTIVE')
    await json('PutRecord', { StreamName: name, PartitionKey: 'p', Data: Buffer.from('event').toString('base64') })
    const session = connect(target.endpoint)
    const codec = new EventStreamCodec(bytes => Buffer.from(bytes).toString('utf8'), text => new Uint8Array(Buffer.from(text, 'utf8')))
    try {
      const events = await new Promise<any[]>((resolve, reject) => {
        const stream = session.request({
          ':method': 'POST', ':path': '/', 'content-type': AMZ_CBOR, 'x-amz-target': 'Kinesis_20131202.SubscribeToShard', ...AUTH,
        })
        let buffered = Buffer.alloc(0)
        const messages: any[] = []
        stream.on('response', headers => assert.equal(headers['content-type'], 'application/vnd.amazon.eventstream'))
        stream.on('data', (chunk: Buffer) => {
          buffered = Buffer.concat([buffered, chunk])
          while (buffered.length >= 4 && buffered.length >= buffered.readUInt32BE(0)) {
            const length = buffered.readUInt32BE(0)
            messages.push(codec.decode(new Uint8Array(buffered.subarray(0, length))))
            buffered = buffered.subarray(length)
          }
          if (messages.length >= 2) {
            stream.close()
            resolve(messages)
          }
        })
        stream.on('error', reject)
        stream.end(Buffer.from(encode({ ConsumerARN: consumerArn, ShardId: 'shardId-000000000000', StartingPosition: { Type: 'TRIM_HORIZON' } })))
      })
      assert.equal(events[0].headers[':event-type'].value, 'initial-response')
      assert.equal(events[1].headers[':event-type'].value, 'SubscribeToShardEvent')
      assert.equal(events[1].headers[':content-type'].value, AMZ_CBOR)
      const payload = decode(events[1].body) as any
      assert.deepEqual(Buffer.from(payload.Records[0].Data).toString(), 'event')
      assert.ok(Number.isInteger(payload.Records[0].ApproximateArrivalTimestamp))
      assert.ok(payload.ContinuationSequenceNumber)
    } finally {
      await new Promise(resolve => session.close(() => resolve(undefined)))
    }
  })
})

describe('request limits', () => {
  it('rejects bodies above 16 MiB with 413', async () => {
    const response = await send(target.endpoint, {
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Kinesis_20131202.ListStreams', ...AUTH },
      body: Buffer.alloc(16 * 1024 * 1024 + 1, 32),
    })
    assert.equal(response.status, 413)
  })
})

function http1OverTls(endpoint: string, method = 'POST') {
  return new Promise<{ status: number, version: string, subject: string }>((resolve, reject) => {
    const req = httpsRequest(endpoint, {
      method,
      agent: false,
      rejectUnauthorized: false,
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Kinesis_20131202.ListStreams', ...AUTH },
    }, res => {
      const subject = (res.socket as TLSSocket).getPeerCertificate().subject.CN as string
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, version: res.httpVersion, subject }))
    })
    req.on('error', reject)
    req.end(method === 'POST' ? '{}' : undefined)
  })
}

async function http2OverTls(endpoint: string) {
  const session = connect(endpoint, { rejectUnauthorized: false })
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const stream = session.request({ ':method': 'POST', ':path': '/', 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Kinesis_20131202.ListStreams', ...AUTH })
      let status = 0
      stream.on('response', headers => { status = Number(headers[':status']) })
      stream.on('end', () => resolve(status))
      stream.on('error', reject)
      stream.resume()
      stream.end('{}')
    })
    return { status, alpn: session.alpnProtocol }
  } finally {
    await new Promise(resolve => session.close(() => resolve(undefined)))
  }
}

function writeCertificate(name: string) {
  const directory = mkdtempSync(join(tmpdir(), 'kinesis-tls-'))
  const { key, cert } = selfSignedCertificate(name)
  writeFileSync(join(directory, 'key.pem'), key)
  writeFileSync(join(directory, 'cert.pem'), cert)
  return { keyFile: join(directory, 'key.pem'), certFile: join(directory, 'cert.pem') }
}

describe('TLS', () => {
  it('serves TLS and plain HTTP on the same port', async () => {
    const secureEndpoint = target.endpoint.replace(/^http:/, 'https:')
    assert.deepEqual(await http2OverTls(secureEndpoint), { status: 200, alpn: 'h2' })
    const http1 = await http1OverTls(secureEndpoint)
    assert.equal(http1.status, 200)
    assert.equal(http1.version, '1.1')
    assert.equal(http1.subject, 'localhost')
    assert.equal((await json('ListStreams', {})).status, 200)
  })

  it('serves HTTP/2 and HTTP/1.1 over TLS only with --ssl', async () => {
    const secure = await startTarget({ ssl: true })
    try {
      assert.match(secure.endpoint, /^https:/)
      assert.deepEqual(await http2OverTls(secure.endpoint), { status: 200, alpn: 'h2' })
      assert.equal((await http1OverTls(secure.endpoint)).status, 200)
      await assert.rejects(call(secure.endpoint.replace(/^https:/, 'http:'), 'ListStreams', {}))
    } finally {
      await secure.close()
    }
  })

  for (const ssl of [false, true]) {
    it(`uses the key and certificate files given on the command line${ssl ? ' with --ssl' : ''}`, async () => {
      const files = writeCertificate('kinesis.test')
      const secure = await startTarget({ ssl, ...files })
      try {
        const { subject } = await http1OverTls(secure.endpoint.replace(/^http:/, 'https:'), 'GET')
        assert.equal(subject, 'kinesis.test')
      } finally {
        await secure.close()
      }
    })
  }

  it('closes a TLS connection that is still open at shutdown', async () => {
    const own = await startTarget()
    const session = connect(own.endpoint.replace(/^http:/, 'https:'), { rejectUnauthorized: false })
    const closed = new Promise(resolve => session.once('close', resolve))
    session.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      const stream = session.request({ ':method': 'GET', ':path': '/healthz' })
      stream.on('end', () => resolve())
      stream.on('error', reject)
      stream.resume()
      stream.end()
    })
    await own.close()
    await closed
  })
})
