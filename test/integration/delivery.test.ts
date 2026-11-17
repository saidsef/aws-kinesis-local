import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, it } from 'node:test'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import {
  CreateChannelCommand, CreateStreamCommand, DeleteChannelCommand, DescribeChannelCommand, DescribeStreamCommand, PutRecordCommand,
  PutRecordsCommand, SplitShardCommand, type KinesisClient,
} from '@aws-sdk/client-kinesis'
import type { StartOptions } from '../../src/index.ts'
import { kinesis, startTarget, unique, waitFor, type Target } from './helpers.ts'

const INTERVAL_MS = 100
const BUCKET = 'delivery-bucket'
const SUFFIX = '-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

interface Upload {
  bucket: string
  key: string
  body: Buffer
  authorization: string
}

class FakeS3 {
  readonly uploads: Upload[] = []
  endpoint = ''
  attempts = 0
  failing = 0
  private readonly server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      this.attempts++
      if (this.failing > 0) {
        this.failing--
        res.writeHead(503, { 'content-type': 'application/xml' })
        res.end('<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>')
        return
      }
      const [, bucket, ...key] = decodeURIComponent(req.url ?? '').split('/')
      this.uploads.push({ bucket: bucket!, key: key.join('/'), body: Buffer.concat(chunks), authorization: req.headers.authorization ?? '' })
      res.end()
    })
  })

  async start() {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  close() {
    this.server.close()
  }

  objects(keyPart: string) {
    return this.uploads.filter(upload => upload.key.includes(keyPart))
  }

  lines(keyPart: string) {
    return this.objects(keyPart).flatMap(upload => content(upload).toString('utf8').split('\n').slice(0, -1))
  }
}

function content(upload: Upload) {
  if (upload.key.endsWith('.gz')) return gunzipSync(upload.body)
  if (upload.key.endsWith('.zst')) return zstdDecompressSync(upload.body)
  return upload.body
}

async function onDemandStream(client: KinesisClient, name: string) {
  await client.send(new CreateStreamCommand({ StreamName: name, StreamModeDetails: { StreamMode: 'ON_DEMAND' } }))
  const { StreamDescription } = await waitFor(
    () => client.send(new DescribeStreamCommand({ StreamName: name })),
    result => result.StreamDescription?.StreamStatus === 'ACTIVE',
  )
  return StreamDescription!.StreamARN!
}

type Format = 'JSON' | 'STRING' | 'BYTE_ARRAY'
type Compression = 'NONE' | 'GZIP' | 'ZSTD'

async function activeChannel(client: KinesisClient, name: string, streams: [string, Format][], compression: Compression, template?: string) {
  const created = await client.send(new CreateChannelCommand({
    ChannelName: name,
    ServiceExecutionRoleARN: 'arn:aws:iam::000000000000:role/channel',
    StreamConfigurationList: streams.map(([StreamARN, RecordFormatType]) => ({ StreamARN, RecordConfiguration: { RecordFormatType } })),
    S3DestinationConfiguration: {
      StorageConfiguration: { BucketARN: `arn:aws:s3:::${BUCKET}`, ExpectedBucketOwner: '000000000000', CompressionType: compression, OutputKeyTemplate: template },
    },
  }))
  const ChannelARN = created.ChannelDescription!.ChannelARN!
  const { ChannelDescription } = await waitFor(
    () => client.send(new DescribeChannelCommand({ ChannelARN })),
    result => result.ChannelDescription?.ChannelStatus === 'ACTIVE',
  )
  return ChannelDescription!
}

function put(client: KinesisClient, streamName: string, values: string[], hashKey?: string) {
  return client.send(new PutRecordsCommand({
    StreamName: streamName,
    Records: values.map(value => ({ Data: Buffer.from(value), PartitionKey: 'key', ...(hashKey ? { ExplicitHashKey: hashKey } : {}) })),
  }))
}

describe('channel delivery', () => {
  const s3 = new FakeS3()
  before(() => s3.start())
  after(() => s3.close())

  async function deliver(work: (client: KinesisClient, target: Target) => Promise<void>, options: Partial<StartOptions> = {}) {
    const target = await startTarget({
      s3Endpoint: s3.endpoint,
      s3AccessKeyId: 'test-key',
      s3SecretAccessKey: 'test-secret',
      deliveryIntervalMs: INTERVAL_MS,
      ...options,
    })
    const client = kinesis(target.endpoint)
    try {
      await work(client, target)
    } finally {
      client.destroy()
      await target.close()
    }
  }

  it('delivers the records that arrive after the channel becomes active, one object for each stream', async () => {
    await deliver(async client => {
      const jsonStream = unique('delivery-json')
      const bytesStream = unique('delivery-bytes')
      const jsonARN = await onDemandStream(client, jsonStream)
      const bytesARN = await onDemandStream(client, bytesStream)
      await put(client, jsonStream, ['{"before":true}'])
      const channel = await activeChannel(client, unique('delivery'), [[jsonARN, 'JSON'], [bytesARN, 'BYTE_ARRAY']], 'GZIP')
      await put(client, jsonStream, ['{"id":1}', '{"id":2}', '{"id":3}'])
      await put(client, bytesStream, ['ab', 'cd'])
      const name = channel.ChannelName!
      const id = channel.ChannelId!
      const objects = await waitFor(async () => s3.objects(name), uploads => uploads.length >= 2)
      assert.deepEqual(objects.map(upload => content(upload).toString('utf8')).sort(), ['abcd', '{"id":1}\n{"id":2}\n{"id":3}\n'])
      const key = new RegExp(`^kinesis-channel/${name}/${id}/\\d{4}/\\d{2}/\\d{2}/\\d{2}/${name}-${id}-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}${SUFFIX}\\.gz$`)
      for (const upload of objects) {
        assert.equal(upload.bucket, BUCKET)
        assert.match(upload.key, key)
        assert.match(upload.authorization, /^AWS4-HMAC-SHA256 Credential=test-key\/\d{8}\/eu-west-1\/s3\/aws4_request,/)
      }
    })
  })

  it('writes objects with the key template and compression of the channel', async () => {
    await deliver(async client => {
      const zstdStream = unique('delivery-zstd')
      const plainStream = unique('delivery-plain')
      const zstdARN = await onDemandStream(client, zstdStream)
      const plainARN = await onDemandStream(client, plainStream)
      await activeChannel(client, unique('delivery'), [[zstdARN, 'STRING']], 'ZSTD', 'data/!{stream-name}/!{yyyy}!{MM}!{dd}!{extension}')
      await activeChannel(client, unique('delivery'), [[plainARN, 'BYTE_ARRAY']], 'NONE', '!{stream-name}/records')
      await put(client, zstdStream, ['first line', 'second line'])
      await put(client, plainStream, ['\u0000\u0001', '\u0002'])
      await waitFor(async () => s3.lines(zstdStream).length + s3.objects(plainStream).length, count => count >= 3)
      assert.deepEqual(s3.lines(zstdStream), ['first line', 'second line'])
      assert.match(s3.objects(zstdStream)[0]!.key, new RegExp(`^data/${zstdStream}/\\d{8}${SUFFIX}\\.zst$`))
      assert.deepEqual(s3.objects(plainStream).map(upload => [...upload.body]), [[0, 1, 2]])
      assert.match(s3.objects(plainStream)[0]!.key, new RegExp(`^${plainStream}/records${SUFFIX}$`))
    })
  })

  it('keeps the records of a failed upload until a retry succeeds', async () => {
    await deliver(async client => {
      const stream = unique('delivery-retry')
      const streamARN = await onDemandStream(client, stream)
      const { ChannelName } = await activeChannel(client, unique('delivery'), [[streamARN, 'STRING']], 'NONE')
      const attempts = s3.attempts
      s3.failing = 2
      await put(client, stream, ['a'])
      await waitFor(async () => s3.attempts - attempts, count => count >= 1)
      await put(client, stream, ['b'])
      await waitFor(async () => s3.lines(ChannelName!), lines => lines.length >= 2)
      assert.equal(s3.failing, 0)
      assert.deepEqual(s3.lines(ChannelName!), ['a', 'b'])
    })
  })

  it('carries on from the saved position after a restart', async () => {
    const path = mkdtempSync(join(tmpdir(), 'kinesis-delivery-'))
    const stream = unique('delivery-restart')
    const channelName = unique('delivery')
    await deliver(async client => {
      const streamARN = await onDemandStream(client, stream)
      await activeChannel(client, channelName, [[streamARN, 'STRING']], 'NONE')
      await put(client, stream, ['one'])
      await waitFor(async () => s3.lines(channelName), lines => lines.length === 1)
      const attempts = s3.attempts
      s3.failing = Infinity
      await put(client, stream, ['two'])
      await waitFor(async () => s3.attempts - attempts, count => count >= 1)
    }, { path })
    s3.failing = 0
    await deliver(async client => {
      await put(client, stream, ['three'])
      await waitFor(async () => s3.lines(channelName), lines => lines.length >= 3)
      await sleep(INTERVAL_MS * 3)
      assert.deepEqual(s3.lines(channelName), ['one', 'two', 'three'])
    }, { path })
  })

  it('reads the child shards of a split once it has delivered the parent shard', async () => {
    await deliver(async client => {
      const stream = unique('delivery-split')
      const streamARN = await onDemandStream(client, stream)
      const { ChannelName } = await activeChannel(client, unique('delivery'), [[streamARN, 'STRING']], 'NONE')
      s3.failing = Infinity
      await put(client, stream, ['parent-1', 'parent-2', 'parent-3'], '0')
      await client.send(new SplitShardCommand({ StreamName: stream, ShardToSplit: 'shardId-000000000000', NewStartingHashKey: (2n ** 125n).toString() }))
      await waitFor(
        () => client.send(new DescribeStreamCommand({ StreamName: stream })),
        result => result.StreamDescription?.StreamStatus === 'ACTIVE',
      )
      const child = await client.send(new PutRecordCommand({ StreamName: stream, Data: Buffer.from('child-1'), PartitionKey: 'key', ExplicitHashKey: '0' }))
      assert.equal(child.ShardId, 'shardId-000000000004')
      await put(client, stream, ['child-2'], '0')
      s3.failing = 0
      await waitFor(async () => s3.lines(ChannelName!), lines => lines.length >= 5)
      assert.deepEqual(s3.lines(ChannelName!), ['parent-1', 'parent-2', 'parent-3', 'child-1', 'child-2'])
    })
  })

  it('stops delivering when the channel is deleted or reset', async () => {
    await deliver(async (client, target) => {
      const deleted = unique('delivery-deleted')
      const deletedARN = await onDemandStream(client, deleted)
      const channel = await activeChannel(client, unique('delivery'), [[deletedARN, 'STRING']], 'NONE')
      await put(client, deleted, ['kept'])
      await waitFor(async () => s3.lines(channel.ChannelName!), lines => lines.length === 1)
      await client.send(new DeleteChannelCommand({ ChannelARN: channel.ChannelARN }))
      await put(client, deleted, ['dropped'])

      const reset = unique('delivery-reset')
      const channelName = unique('delivery')
      await activeChannel(client, channelName, [[await onDemandStream(client, reset), 'STRING']], 'NONE')
      s3.failing = Infinity
      await put(client, reset, ['before reset'])
      await sleep(INTERVAL_MS * 3)
      target.server!.reset(reset)
      s3.failing = 0
      await activeChannel(client, channelName, [[await onDemandStream(client, reset), 'STRING']], 'NONE')
      await put(client, reset, ['after reset'])
      await waitFor(async () => s3.lines(channelName), lines => lines.length >= 1)
      await sleep(INTERVAL_MS * 5)
      assert.deepEqual(s3.lines(channel.ChannelName!), ['kept'])
      assert.deepEqual(s3.lines(channelName), ['after reset'])
    })
  })

  it('refuses to start without credentials for the S3 endpoint', async () => {
    await assert.rejects(startTarget({ s3Endpoint: s3.endpoint, s3AccessKeyId: undefined, s3SecretAccessKey: undefined }), /S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/)
    await assert.rejects(startTarget({ s3Endpoint: 'ftp://127.0.0.1', s3AccessKeyId: 'a', s3SecretAccessKey: 'b' }), /not an http or https URL/)
  })
})
