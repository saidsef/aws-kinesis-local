import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createShardIterator, readShardIterator } from '../../src/kinesis/iterator.ts'
import {
  MAX_SEQUENCE_INDEX, incrementSequence, parseSequence, partitionKeyToHashKey, resolveShardId, shardIdName, shardIxToHex,
  stringifySequence,
} from '../../src/kinesis/sequence.ts'

const KINESALITE_SEQUENCES = [
  '49680000635013247049592121295397200375299077975780098050',
  '49680000635013247049592121295398409301118692948552187906',
  '49680000635013247049592121295406871781855995490214084610',
  '49680000635024397422191386606966759308615788489431056386',
  '49680000640387726642438001472507308479007334129513529362',
  '49680000640410027387636532095648844197279982491019509794',
  '49680000635035547794790651918538736093571726543444508690',
  '49680000635035547794790651918544780722669800445232283666',
]

describe('sequence numbers', () => {
  it('round-trips sequence numbers in the kinesalite format', () => {
    for (const sequence of KINESALITE_SEQUENCES) {
      const parts = parseSequence(sequence)
      assert.equal(parts.version, 2)
      assert.equal(stringifySequence(parts), sequence)
    }
  })

  it('encodes the shard index, counter and times of a version 2 sequence', () => {
    const sequence = stringifySequence({ shardCreateTime: 1794063723000, shardIx: 3, seqIx: 42, seqTime: 1794063730000 })
    assert.match(sequence, /^\d{56}$/)
    const parts = parseSequence(sequence)
    assert.equal(parts.shardIx, 3)
    assert.equal(parts.seqIx, '42')
    assert.equal(parts.shardCreateTime, 1794063723000)
    assert.equal(parts.seqTime, 1794063730000)
  })

  it('orders sequence numbers in a shard by counter and then by time', () => {
    const base = { shardCreateTime: 1794063723000, shardIx: 1 }
    const first = stringifySequence({ ...base, seqIx: 5, seqTime: 1794063799000 })
    const second = stringifySequence({ ...base, seqIx: 6, seqTime: 1794063724000 })
    assert.ok(BigInt(first) < BigInt(second))
    assert.ok(first < second)
  })

  it('moves an iterator past a record by adding one second to its time', () => {
    const record = stringifySequence({ shardCreateTime: 1794063723000, shardIx: 0, seqIx: 9, seqTime: 1794063725000 })
    const next = parseSequence(incrementSequence(record))
    assert.equal(next.seqIx, '9')
    assert.equal(next.seqTime, 1794063726000)
    assert.ok(BigInt(incrementSequence(record)) > BigInt(record))
  })

  it('closes a shard with the largest counter', () => {
    const end = parseSequence(stringifySequence({ shardCreateTime: 1794063723000, shardIx: 2, seqIx: MAX_SEQUENCE_INDEX, seqTime: 1794063900000 }))
    assert.equal(end.seqIx, MAX_SEQUENCE_INDEX.toString())
  })

  it('parses the older version 0 and version 1 formats', () => {
    const version1 = stringifySequence({ version: 1, shardCreateTime: 1794063723000, shardIx: 4, seqIx: 3, seqTime: 1794063724000 })
    assert.equal(parseSequence(version1).version, 1)
    assert.equal(parseSequence(version1).shardIx, 4)
    const version0 = parseSequence('1')
    assert.equal(version0.version, 0)
    assert.ok(Number.isNaN(version0.seqTime))
  })

  it('rejects text that is not a sequence number', () => {
    assert.throws(() => parseSequence(''))
    assert.throws(() => parseSequence('12a'))
    assert.throws(() => parseSequence('9'.repeat(70)))
  })
})

describe('shard identifiers', () => {
  it('formats shard indexes as kinesalite does', () => {
    assert.equal(shardIdName(0), 'shardId-000000000000')
    assert.equal(shardIdName(1234), 'shardId-000000001234')
    assert.equal(shardIxToHex(255), '000000ff')
  })

  it('resolves shard IDs written in several forms', () => {
    assert.deepEqual(resolveShardId('shardId-000000000007'), { shardId: 'shardId-000000000007', shardIx: 7 })
    assert.deepEqual(resolveShardId('7'), { shardId: 'shardId-000000000007', shardIx: 7 })
    assert.deepEqual(resolveShardId('anything-12'), { shardId: 'shardId-000000000012', shardIx: 12 })
    assert.equal(resolveShardId('shard'), null)
    assert.equal(resolveShardId('shardId-2147483648'), null)
  })

  it('hashes partition keys with MD5', () => {
    assert.equal(partitionKeyToHashKey('a'), BigInt('0x0cc175b9c0f1b6a831c399e269772661'))
  })
})

describe('shard iterators', () => {
  it('round-trips the stream, shard and position', () => {
    const iterator = createShardIterator('stream', 'shardId-000000000001', '49680000635013247049592121295397200375299077975780098050', 1794063723000)
    assert.deepEqual(readShardIterator(iterator), {
      createdAt: 1794063723000,
      streamName: 'stream',
      shardId: 'shardId-000000000001',
      sequenceNumber: '49680000635013247049592121295397200375299077975780098050',
    })
  })

  it('grows with the stream name like kinesalite iterators', () => {
    const length = (name: string) => Buffer.from(createShardIterator(name, 'shardId-000000000000', '1'), 'base64').length
    assert.equal(length('a'), length('ab'))
    assert.ok(length('a'.repeat(128)) > length('a'))
  })

  it('rejects iterators that the server did not issue', () => {
    assert.equal(readShardIterator('AAAA'), null)
    assert.equal(readShardIterator(Buffer.alloc(160, 1).toString('base64')), null)
  })
})
