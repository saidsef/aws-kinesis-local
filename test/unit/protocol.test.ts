import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EventStreamCodec } from '@smithy/eventstream-codec'
import { decode, encode, Tag } from 'cbor2'
import { decodeCbor, encodeCbor } from '../../src/protocol/cbor.ts'
import { encodeEvent } from '../../src/protocol/eventstream.ts'
import { serializeShape } from '../../src/protocol/serialize.ts'

const utf8 = { toUtf8: (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8'), fromUtf8: (text: string) => new Uint8Array(Buffer.from(text, 'utf8')) }

describe('CBOR', () => {
  it('decodes what an independent encoder writes', () => {
    const value = {
      StreamName: 'stream',
      ShardCount: 3,
      Negative: -70000,
      Big: 2 ** 40,
      Ratio: 1.5,
      Flag: true,
      Missing: null,
      Data: new Uint8Array([1, 2, 3]),
      Records: [{ PartitionKey: 'é', Data: new Uint8Array(300) }],
    }
    const decoded = decodeCbor(Buffer.from(encode(value))) as Record<string, unknown>
    assert.equal(decoded.StreamName, 'stream')
    assert.equal(decoded.ShardCount, 3)
    assert.equal(decoded.Negative, -70000)
    assert.equal(decoded.Big, 2 ** 40)
    assert.equal(decoded.Ratio, 1.5)
    assert.equal(decoded.Flag, true)
    assert.equal(decoded.Missing, null)
    assert.deepEqual(decoded.Data, Buffer.from([1, 2, 3]))
    assert.equal((decoded.Records as { PartitionKey: string }[])[0]!.PartitionKey, 'é')
  })

  it('reads indefinite-length maps, arrays and strings that Jackson writes', () => {
    const bytes = Buffer.from([0xbf, 0x61, 0x61, 0x9f, 0x01, 0x02, 0xff, 0x61, 0x62, 0x7f, 0x62, 0x68, 0x69, 0x61, 0x21, 0xff, 0xff])
    assert.deepEqual(decodeCbor(bytes), { a: [1, 2], b: 'hi!' })
  })

  it('reads half, single and double precision floats', () => {
    assert.equal(decodeCbor(Buffer.from([0xf9, 0x3c, 0x00])), 1)
    assert.equal(decodeCbor(Buffer.from([0xfa, 0x3f, 0xc0, 0x00, 0x00])), 1.5)
    assert.equal(decodeCbor(Buffer.from(encode(0.1))), 0.1)
  })

  it('reads tagged timestamps in seconds and in the milliseconds that the AWS SDK for Java sends', () => {
    assert.deepEqual(decodeCbor(Buffer.from(encode(new Tag(1, 1794063723)))), new Date(1794063723000))
    assert.deepEqual(decodeCbor(Buffer.from(encode(new Tag(1, 1794063723456)))), new Date(1794063723456))
  })

  it('writes values that an independent decoder reads back', () => {
    const value = { a: 'text', b: 42, c: -1, d: 1.25, e: [true, false, null], f: Buffer.from('bytes'), g: { nested: 2 ** 53 - 1 } }
    const decoded = decode(new Uint8Array(encodeCbor(value))) as Record<string, unknown>
    assert.equal(decoded.a, 'text')
    assert.equal(decoded.b, 42)
    assert.equal(decoded.c, -1)
    assert.equal(decoded.d, 1.25)
    assert.deepEqual(decoded.e, [true, false, null])
    assert.deepEqual(Buffer.from(decoded.f as Uint8Array), Buffer.from('bytes'))
    assert.deepEqual(decoded.g, { nested: 2 ** 53 - 1 })
  })

  it('rejects truncated input', () => {
    assert.throws(() => decodeCbor(Buffer.from([0x62, 0x61])))
    assert.throws(() => decodeCbor(Buffer.from([0xff])))
  })
})

describe('event streams', () => {
  it('writes messages that the AWS SDK codec reads', () => {
    const codec = new EventStreamCodec(utf8.toUtf8, utf8.fromUtf8)
    const payload = Buffer.from('{"Records":[]}')
    const message = codec.decode(new Uint8Array(encodeEvent({ ':event-type': 'SubscribeToShardEvent', ':message-type': 'event' }, payload)))
    assert.equal(message.headers[':event-type']?.value, 'SubscribeToShardEvent')
    assert.equal(message.headers[':message-type']?.value, 'event')
    assert.equal(Buffer.from(message.body).toString(), '{"Records":[]}')
  })
})

describe('serialisation', () => {
  const record = { SequenceNumber: '1', Data: Buffer.from('hello'), ApproximateArrivalTimestamp: 1794063723.456, PartitionKey: 'p', Unknown: 1 }

  it('writes base64 blobs and epoch seconds for JSON', () => {
    const json = serializeShape({ Records: [record], MillisBehindLatest: 0 }, 'GetRecordsOutput', 'json') as { Records: Record<string, unknown>[] }
    assert.equal(json.Records[0]!.Data, 'aGVsbG8=')
    assert.equal(json.Records[0]!.ApproximateArrivalTimestamp, 1794063723.456)
  })

  it('writes byte strings and epoch milliseconds for CBOR', () => {
    const cbor = serializeShape({ Records: [record], MillisBehindLatest: 0 }, 'GetRecordsOutput', 'cbor') as { Records: Record<string, unknown>[] }
    assert.deepEqual(cbor.Records[0]!.Data, Buffer.from('hello'))
    assert.equal(cbor.Records[0]!.ApproximateArrivalTimestamp, 1794063723456)
  })
})
