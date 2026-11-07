import { createCipheriv, createDecipheriv } from 'node:crypto'

const KEY = Buffer.from('1133a5a833666b49abf28c8ba302930f0b2fb240dccd43cf4dfbc0ca91f17751', 'hex')
const IV = Buffer.from('7bf139dbabbea2d9995d6fcae1dff7da', 'hex')
const HEADER = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])
export const ITERATOR_TTL_MS = 300000

export interface IteratorContents {
  createdAt: number
  streamName: string
  shardId: string
  sequenceNumber: string
}

export function createShardIterator(streamName: string, shardId: string, sequenceNumber: string, now = Date.now()) {
  const plain = [('0000000000000' + now).slice(-14), streamName, shardId, sequenceNumber, '0'.repeat(36)].join('/')
  const cipher = createCipheriv('aes-256-cbc', KEY, IV)
  return Buffer.concat([HEADER, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64')
}

export function readShardIterator(iterator: string): IteratorContents | null {
  const buffer = Buffer.from(iterator, 'base64')
  if (buffer.length < 152 || buffer.length > 280 || buffer.toString('base64') !== iterator) return null
  if (!buffer.subarray(0, 8).equals(HEADER)) return null
  let pieces: string[]
  try {
    const decipher = createDecipheriv('aes-256-cbc', KEY, IV)
    pieces = Buffer.concat([decipher.update(buffer.subarray(8)), decipher.final()]).toString('utf8').split('/')
  } catch {
    return null
  }
  if (pieces.length !== 5) return null
  const [createdAt, streamName, shardId, sequenceNumber] = pieces as [string, string, string, string]
  return { createdAt: +createdAt, streamName, shardId, sequenceNumber }
}
