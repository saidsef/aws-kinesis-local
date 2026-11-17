import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { S3Error, authorization, putObject, type SignableRequest } from '../../src/delivery/s3.ts'

const EXAMPLE_CREDENTIALS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const EXAMPLE_SCOPE = 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request'

const AWS_EXAMPLES: { name: string, request: SignableRequest, authorization: string }[] = [
  {
    name: 'GET Object',
    request: {
      method: 'GET',
      path: '/test.txt',
      headers: {
        Host: 'examplebucket.s3.amazonaws.com',
        Range: 'bytes=0-9 ',
        'x-amz-content-sha256': EMPTY_SHA256,
        'x-amz-date': ' 20130524T000000Z ',
      },
    },
    authorization: `${EXAMPLE_SCOPE},SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`,
  },
  {
    name: 'PUT Object',
    request: {
      method: 'PUT',
      path: '/test$file.text',
      headers: {
        Host: 'examplebucket.s3.amazonaws.com',
        Date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-date': ' 20130524T000000Z ',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        'x-amz-content-sha256': createHash('sha256').update('Welcome to Amazon S3.').digest('hex'),
      },
    },
    authorization: `${EXAMPLE_SCOPE},SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd`,
  },
  {
    name: 'GET Bucket Lifecycle',
    request: {
      method: 'GET',
      path: '/',
      query: { lifecycle: '' },
      headers: {
        Host: 'examplebucket.s3.amazonaws.com',
        'x-amz-date': ' 20130524T000000Z ',
        'x-amz-content-sha256': EMPTY_SHA256,
      },
    },
    authorization: `${EXAMPLE_SCOPE},SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543`,
  },
  {
    name: 'GET Bucket (List Objects)',
    request: {
      method: 'GET',
      path: '/',
      query: { prefix: 'J', 'max-keys': '2' },
      headers: {
        Host: 'examplebucket.s3.amazonaws.com',
        'x-amz-date': ' 20130524T000000Z ',
        'x-amz-content-sha256': EMPTY_SHA256,
      },
    },
    authorization: `${EXAMPLE_SCOPE},SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7`,
  },
]

describe('S3 request signatures', () => {
  for (const example of AWS_EXAMPLES) {
    it(`reproduces the ${example.name} example that AWS publishes`, () => {
      assert.equal(authorization(example.request, 'us-east-1', EXAMPLE_CREDENTIALS), example.authorization)
    })
  }

  it('refuses to sign a request without x-amz-date', () => {
    const request = { method: 'PUT', path: '/bucket/key', headers: { host: 'localhost', 'x-amz-content-sha256': EMPTY_SHA256 } }
    assert.throws(() => authorization(request, 'us-east-1', EXAMPLE_CREDENTIALS), /x-amz-date/)
  })
})

interface Received {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
}

const REGION = 'eu-west-2'
const SECRETS: Record<string, string> = { AKIDLOCAL: 'local/secret+key' }
const CREDENTIALS = { accessKeyId: 'AKIDLOCAL', secretAccessKey: 'local/secret+key' }

function xmlError(res: ServerResponse, statusCode: number, code: string, message: string) {
  res.writeHead(statusCode, { 'content-type': 'application/xml' })
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message><RequestId>1</RequestId></Error>`)
}

function verify(received: Received, res: ServerResponse) {
  if (received.url.startsWith('/gateway/')) {
    res.writeHead(502, { 'content-type': 'text/plain' })
    return res.end('Bad Gateway')
  }
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/[^,]+,SignedHeaders=([^,]+),Signature=[0-9a-f]{64}$/.exec(String(received.headers.authorization))
  if (!match) return xmlError(res, 400, 'AuthorizationHeaderMalformed', 'The authorization header is malformed.')
  const accessKeyId = match[1]!
  const signedHeaders = match[2]!
  const secretAccessKey = SECRETS[accessKeyId]
  if (secretAccessKey === undefined) return xmlError(res, 403, 'InvalidAccessKeyId', 'The Access Key Id you provided does not exist in our records.')
  if (received.headers['x-amz-content-sha256'] !== createHash('sha256').update(received.body).digest('hex')) {
    return xmlError(res, 400, 'XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 header does not match what was computed.')
  }
  const headers: Record<string, string> = {}
  for (const name of signedHeaders.split(';')) headers[name] = String(received.headers[name])
  const url = new URL(received.url, 'http://localhost')
  const expected = authorization({ method: received.method, path: decodeURIComponent(url.pathname), headers }, REGION, { accessKeyId, secretAccessKey })
  if (expected !== received.headers.authorization) {
    return xmlError(res, 403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.')
  }
  res.writeHead(200, { etag: '"0"' })
  res.end()
}

describe('S3 uploads', () => {
  const received: Received[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const request = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) }
      received.push(request)
      verify(request, res)
    })
  })
  let endpoint = ''

  before(async () => {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    server.close()
    await once(server, 'close')
  })

  it('uploads an object with a signed path-style request', async () => {
    const body = '{"data":"one"}\n{"data":"two"}\n'
    await putObject({ endpoint, region: REGION, credentials: CREDENTIALS }, {
      bucket: 'delivery',
      key: 'channel/2026/11/17/part 1+(a)*~é.json',
      body,
      headers: { 'content-type': 'application/json' },
    })
    const request = received.at(-1)!
    assert.equal(request.method, 'PUT')
    assert.equal(request.url, '/delivery/channel/2026/11/17/part%201%2B%28a%29%2A~%C3%A9.json')
    assert.equal(request.body.toString('utf8'), body)
    assert.equal(request.headers['content-type'], 'application/json')
    assert.equal(request.headers['content-length'], String(Buffer.byteLength(body)))
    assert.match(String(request.headers['x-amz-date']), /^\d{8}T\d{6}Z$/)
    assert.match(String(request.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDLOCAL\/\d{8}\/eu-west-2\/s3\/aws4_request,SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date,/)
  })

  it('uploads a binary body unchanged', async () => {
    const body = Buffer.from([0, 255, 1, 254, 10, 13])
    await putObject({ endpoint, region: REGION, credentials: CREDENTIALS }, { bucket: 'delivery', key: 'records.bin', body })
    assert.deepEqual(received.at(-1)!.body, body)
  })

  it('puts the path of the endpoint in front of the bucket', async () => {
    await putObject({ endpoint: `${endpoint}/storage/`, region: REGION, credentials: CREDENTIALS }, { bucket: 'delivery', key: 'object', body: 'x' })
    assert.equal(received.at(-1)!.url, '/storage/delivery/object')
  })

  it('reports the status code and error code of a rejected signature', async () => {
    const credentials = { accessKeyId: 'AKIDLOCAL', secretAccessKey: 'wrong' }
    await assert.rejects(putObject({ endpoint, region: REGION, credentials }, { bucket: 'delivery', key: 'object', body: 'x' }), error => {
      assert.ok(error instanceof S3Error)
      assert.equal(error.statusCode, 403)
      assert.equal(error.code, 'SignatureDoesNotMatch')
      assert.equal(error.message, 'PutObject delivery/object failed with status 403 and error code SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.')
      return true
    })
  })

  it('reports the error code of an unknown access key', async () => {
    const credentials = { accessKeyId: 'AKIDUNKNOWN', secretAccessKey: 'local/secret+key' }
    await assert.rejects(putObject({ endpoint, region: REGION, credentials }, { bucket: 'delivery', key: 'object', body: 'x' }), {
      name: 'S3Error',
      statusCode: 403,
      code: 'InvalidAccessKeyId',
    })
  })

  it('reports the status code of a response without an S3 error', async () => {
    await assert.rejects(putObject({ endpoint, region: REGION, credentials: CREDENTIALS }, { bucket: 'gateway', key: 'object', body: 'x' }), {
      name: 'S3Error',
      statusCode: 502,
      code: undefined,
      message: 'PutObject gateway/object failed with status 502',
    })
  })

  it('rejects when the endpoint refuses the connection', async () => {
    const closed = createServer()
    closed.listen(0, '127.0.0.1')
    await once(closed, 'listening')
    const { port } = closed.address() as AddressInfo
    closed.close()
    await once(closed, 'close')
    await assert.rejects(putObject({ endpoint: `http://127.0.0.1:${port}`, region: REGION, credentials: CREDENTIALS }, { bucket: 'delivery', key: 'object', body: 'x' }), {
      code: 'ECONNREFUSED',
    })
  })
})
