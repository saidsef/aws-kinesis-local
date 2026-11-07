import { crc32 } from 'node:zlib'

const STRING_HEADER = 7

export type EventHeaders = Record<string, string>

export function encodeEvent(headers: EventHeaders, payload: Buffer): Buffer {
  const headerParts: Buffer[] = []
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const valueBytes = Buffer.from(value, 'utf8')
    const header = Buffer.alloc(1 + nameBytes.length + 3 + valueBytes.length)
    header.writeUInt8(nameBytes.length, 0)
    nameBytes.copy(header, 1)
    header.writeUInt8(STRING_HEADER, 1 + nameBytes.length)
    header.writeUInt16BE(valueBytes.length, 2 + nameBytes.length)
    valueBytes.copy(header, 4 + nameBytes.length)
    headerParts.push(header)
  }
  const headerBytes = Buffer.concat(headerParts)
  const totalLength = 12 + headerBytes.length + payload.length + 4
  const message = Buffer.alloc(totalLength)
  message.writeUInt32BE(totalLength, 0)
  message.writeUInt32BE(headerBytes.length, 4)
  message.writeUInt32BE(crc32(message.subarray(0, 8)), 8)
  headerBytes.copy(message, 12)
  payload.copy(message, 12 + headerBytes.length)
  message.writeUInt32BE(crc32(message.subarray(0, totalLength - 4)), totalLength - 4)
  return message
}
