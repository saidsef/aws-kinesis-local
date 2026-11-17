import { gunzipSync } from 'node:zlib'

const KINESIS = process.env.KINESIS_ENDPOINT ?? 'http://kinesis:4567'
const S3 = process.env.S3_ENDPOINT ?? 'http://s3:8333'
const BUCKET = 'delivery-test'
const RUN = Date.now().toString(36)
const AUTH = 'AWS4-HMAC-SHA256 Credential=test/20261117/eu-west-1/kinesis/aws4_request, SignedHeaders=host;x-amz-date, Signature=0000'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(what, check, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`)
    await sleep(1000)
  }
}

async function kinesis(operation, body) {
  const res = await fetch(KINESIS, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `Kinesis_20131202.${operation}`,
      'x-amz-date': new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''),
      authorization: AUTH,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${operation} failed with status ${res.status}: ${text}`)
  return text ? JSON.parse(text) : {}
}

async function keys(prefix) {
  const res = await fetch(`${S3}/${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}`)
  if (!res.ok) throw new Error(`ListObjectsV2 failed with status ${res.status}: ${await res.text()}`)
  return [...(await res.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map(match => match[1])
}

async function object(key) {
  const res = await fetch(`${S3}/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`)
  if (!res.ok) throw new Error(`GetObject ${key} failed with status ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function activeStream(name) {
  await kinesis('CreateStream', { StreamName: name, StreamModeDetails: { StreamMode: 'ON_DEMAND' } })
  const { StreamDescriptionSummary: summary } = await until(`stream ${name}`, async () => {
    const result = await kinesis('DescribeStreamSummary', { StreamName: name })
    return result.StreamDescriptionSummary.StreamStatus === 'ACTIVE' && result
  })
  return summary.StreamARN
}

async function activeChannel(name, streamARN, format, compression, template) {
  const created = await kinesis('CreateChannel', {
    ChannelName: name,
    ServiceExecutionRoleARN: 'arn:aws:iam::000000000000:role/channel',
    StreamConfigurationList: [{ StreamARN: streamARN, RecordConfiguration: { RecordFormatType: format } }],
    S3DestinationConfiguration: {
      StorageConfiguration: {
        BucketARN: `arn:aws:s3:::${BUCKET}`,
        ExpectedBucketOwner: '000000000000',
        CompressionType: compression,
        ...(template ? { OutputKeyTemplate: template } : {}),
      },
    },
  })
  const { ChannelARN, ChannelId } = created.ChannelDescription
  await until(`channel ${name}`, async () => (await kinesis('DescribeChannel', { ChannelARN })).ChannelDescription.ChannelStatus === 'ACTIVE')
  return ChannelId
}

function put(streamName, values) {
  return kinesis('PutRecords', {
    StreamName: streamName,
    Records: values.map(value => ({ Data: Buffer.from(value).toString('base64'), PartitionKey: 'key' })),
  })
}

function check(condition, message) {
  if (!condition) throw new Error(message)
  console.log(`ok - ${message}`)
}

async function main() {
  await until('aws-kinesis-local', async () => (await fetch(`${KINESIS}/readyz`)).ok)
  await until('the S3 server', async () => {
    const res = await fetch(`${S3}/${BUCKET}`, { method: 'PUT' })
    return res.ok || res.status === 409
  })
  console.log(`Bucket ${BUCKET} is ready`)

  const jsonStream = `delivery-json-${RUN}`
  const jsonChannel = `delivery-json-${RUN}`
  const jsonARN = await activeStream(jsonStream)
  await put(jsonStream, ['{"before":true}'])
  const channelId = await activeChannel(jsonChannel, jsonARN, 'JSON', 'GZIP')
  await put(jsonStream, ['{"id":1}', '{"id":2}', '{"id":3}'])
  const jsonKeys = await until('the JSON object', async () => {
    const found = await keys(`kinesis-channel/${jsonChannel}/`)
    return found.length && found
  })
  check(jsonKeys.length === 1, `channel ${jsonChannel} wrote one object`)
  const pattern = new RegExp(`^kinesis-channel/${jsonChannel}/${channelId}/\\d{4}/\\d{2}/\\d{2}/\\d{2}/${jsonChannel}-${channelId}-[\\d-]{16}-[0-9a-f-]{36}\\.gz$`)
  check(pattern.test(jsonKeys[0]), `key ${jsonKeys[0]} follows the default template`)
  const lines = gunzipSync(await object(jsonKeys[0])).toString('utf8')
  check(lines === '{"id":1}\n{"id":2}\n{"id":3}\n', 'the GZIP object holds the three JSON records, one to a line, without the earlier record')

  const bytesStream = `delivery-bytes-${RUN}`
  const bytesARN = await activeStream(bytesStream)
  await activeChannel(`delivery-bytes-${RUN}`, bytesARN, 'BYTE_ARRAY', 'NONE', '!{stream-name}/records')
  await put(bytesStream, ['ab', 'cd'])
  const bytesKeys = await until('the BYTE_ARRAY object', async () => {
    const found = await keys(`${bytesStream}/`)
    return found.length && found
  })
  check(/^delivery-bytes-[0-9a-z]+\/records-[0-9a-f-]{36}$/.test(bytesKeys[0]), `key ${bytesKeys[0]} follows the custom template`)
  check((await object(bytesKeys[0])).toString('utf8') === 'abcd', 'the uncompressed object holds the BYTE_ARRAY records back to back')

  console.log('PASS: aws-kinesis-local delivered every record to the S3 server')
}

main().catch(error => {
  console.error(`FAIL: ${error.message}`)
  process.exit(1)
})
