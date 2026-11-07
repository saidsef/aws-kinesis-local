import { createHash } from 'node:crypto'

export interface SequenceParts {
  shardCreateTime: number
  shardIx: number
  seqIx?: string | number | bigint | null
  byte1?: string
  seqTime?: number
  seqRand?: string
  version?: number
}

export interface ParsedSequence extends SequenceParts {
  seqTime: number
  version: number
}

const POW_2_124 = 2n ** 124n
const POW_2_124_NEXT = 2n ** 129n
const POW_2_185 = 2n ** 185n
const POW_2_185_NEXT = 3n * 2n ** 184n
export const POW_2_128 = 2n ** 128n
export const MAX_SEQUENCE_INDEX = 0x7fffffffffffffffn

export function parseSequence(sequence: string): ParsedSequence {
  if (!/^\d+$/.test(sequence)) throw new Error(`Invalid sequence number: ${sequence}`)
  let value = BigInt(sequence)
  if (value < POW_2_124) value += POW_2_124
  const hex = value.toString(16)
  const version = value < POW_2_124_NEXT ? 0
    : value > POW_2_185 && value < POW_2_185_NEXT ? parseInt(hex.slice(-1), 16) : null
  if (version === 2) {
    const seqIxHex = hex.slice(11, 27)
    let shardIxHex = hex.slice(38, 46)
    if (parseInt(seqIxHex[0]!, 16) > 7) throw new Error('Sequence index too high')
    if (parseInt(shardIxHex[0]!, 16) > 7) shardIxHex = '-' + shardIxHex
    const shardCreateSecs = parseInt(hex.slice(1, 10), 16)
    if (shardCreateSecs >= 16025175000) throw new Error(`Date too large: ${shardCreateSecs}`)
    return {
      shardCreateTime: shardCreateSecs * 1000,
      seqIx: BigInt('0x' + seqIxHex).toString(),
      byte1: hex.slice(27, 29),
      seqTime: parseInt(hex.slice(29, 38), 16) * 1000,
      shardIx: parseInt(shardIxHex, 16),
      version,
    }
  }
  if (version === 1) {
    return {
      shardCreateTime: parseInt(hex.slice(1, 10), 16) * 1000,
      byte1: hex.slice(11, 13),
      seqTime: parseInt(hex.slice(13, 22), 16) * 1000,
      seqRand: hex.slice(22, 36),
      seqIx: parseInt(hex.slice(36, 38), 16),
      shardIx: parseInt(hex.slice(38, 46), 16),
      version,
    }
  }
  if (version === 0) {
    const shardCreateSecs = parseInt(hex.slice(1, 10), 16)
    if (shardCreateSecs >= 16025175000) throw new Error(`Date too large: ${shardCreateSecs}`)
    return {
      shardCreateTime: shardCreateSecs * 1000,
      byte1: hex.slice(10, 12),
      seqRand: hex.slice(12, 28),
      seqTime: NaN,
      shardIx: parseInt(hex.slice(28, 32), 16),
      version,
    }
  }
  throw new Error(`Unknown version: ${version}`)
}

function hexOfSeconds(milliseconds: number) {
  return ('00000000' + Math.floor(milliseconds / 1000).toString(16)).slice(-9)
}

export function stringifySequence(parts: SequenceParts): string {
  if (parts.version == null || parts.version === 2) {
    return BigInt('0x' + [
      '2',
      hexOfSeconds(parts.shardCreateTime),
      (parts.shardIx || 0).toString(16).slice(-1),
      ('0000000000000000' + BigInt(parts.seqIx || 0).toString(16)).slice(-16),
      parts.byte1 || '00',
      hexOfSeconds(parts.seqTime || parts.shardCreateTime),
      shardIxToHex(parts.shardIx),
      '2',
    ].join('')).toString()
  }
  if (parts.version === 1) {
    return BigInt('0x' + [
      '2',
      hexOfSeconds(parts.shardCreateTime),
      (parts.shardIx || 0).toString(16).slice(-1),
      parts.byte1 || '00',
      hexOfSeconds(parts.seqTime || parts.shardCreateTime),
      parts.seqRand || '00000000000000',
      ('0' + Number(parts.seqIx || 0).toString(16)).slice(-2),
      shardIxToHex(parts.shardIx),
      '1',
    ].join('')).toString()
  }
  if (parts.version === 0) {
    return BigInt('0x' + [
      '1',
      hexOfSeconds(parts.shardCreateTime),
      parts.byte1 || '00',
      parts.seqRand || '0000000000000000',
      shardIxToHex(parts.shardIx).slice(-4),
    ].join('')).toString()
  }
  throw new Error(`Unknown version: ${parts.version}`)
}

export function incrementSequence(sequence: ParsedSequence | string, seqTime?: number) {
  const parsed = typeof sequence === 'string' ? parseSequence(sequence) : sequence
  return stringifySequence({
    shardCreateTime: parsed.shardCreateTime,
    seqIx: parsed.seqIx ?? null,
    seqTime: seqTime || parsed.seqTime + 1000,
    shardIx: parsed.shardIx,
  })
}

export function shardIxToHex(shardIx: number) {
  return ('0000000' + (shardIx || 0).toString(16)).slice(-8)
}

export function shardIdName(shardIx: number) {
  return 'shardId-' + (shardIx < 0 ? '-' : '') + ('00000000000' + Math.abs(shardIx)).slice(shardIx < 0 ? -11 : -12)
}

export function resolveShardId(shardId: string) {
  const suffix = shardId.split('-')[1] || shardId
  const shardIx = /^\d+$/.test(suffix) ? parseInt(suffix, 10) : NaN
  if (!(shardIx >= 0 && shardIx <= 2147483647)) return null
  return { shardId: shardIdName(shardIx), shardIx }
}

export function partitionKeyToHashKey(partitionKey: string) {
  return BigInt('0x' + createHash('md5').update(partitionKey, 'utf8').digest('hex'))
}
