const MILLISECOND_THRESHOLD = 1e11

export class CborError extends Error {}

class Reader {
  readonly buffer: Buffer
  offset = 0

  constructor(buffer: Buffer) {
    this.buffer = buffer
  }

  need(length: number) {
    if (this.offset + length > this.buffer.length) throw new CborError('Unexpected end of CBOR input')
  }

  byte() {
    this.need(1)
    return this.buffer[this.offset++]!
  }

  bytes(length: number) {
    this.need(length)
    const slice = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return slice
  }

  argument(info: number): number | bigint {
    if (info < 24) return info
    if (info === 24) return this.byte()
    if (info === 25) {
      this.need(2)
      const value = this.buffer.readUInt16BE(this.offset)
      this.offset += 2
      return value
    }
    if (info === 26) {
      this.need(4)
      const value = this.buffer.readUInt32BE(this.offset)
      this.offset += 4
      return value
    }
    if (info === 27) {
      this.need(8)
      const value = this.buffer.readBigUInt64BE(this.offset)
      this.offset += 8
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value
    }
    throw new CborError(`Invalid additional information ${info}`)
  }

  length(info: number) {
    const value = this.argument(info)
    if (typeof value === 'bigint') throw new CborError('CBOR length is too large')
    return value
  }
}

const BREAK = Symbol('break')

function halfToNumber(half: number) {
  const exponent = (half >> 10) & 0x1f
  const fraction = half & 0x3ff
  const sign = half & 0x8000 ? -1 : 1
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024)
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

function readItem(reader: Reader): unknown {
  const initial = reader.byte()
  const major = initial >> 5
  const info = initial & 0x1f
  switch (major) {
    case 0: {
      const value = reader.argument(info)
      return typeof value === 'bigint' ? Number(value) : value
    }
    case 1: {
      const value = reader.argument(info)
      return typeof value === 'bigint' ? Number(-1n - value) : -1 - value
    }
    case 2:
    case 3: {
      if (info === 31) {
        const chunks: Buffer[] = []
        for (;;) {
          const chunk = readItem(reader)
          if (chunk === BREAK) break
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
        }
        const joined = Buffer.concat(chunks)
        return major === 2 ? joined : joined.toString('utf8')
      }
      const bytes = reader.bytes(reader.length(info))
      return major === 2 ? Buffer.from(bytes) : bytes.toString('utf8')
    }
    case 4: {
      const items: unknown[] = []
      if (info === 31) {
        for (;;) {
          const item = readItem(reader)
          if (item === BREAK) return items
          items.push(item)
        }
      }
      const count = reader.length(info)
      for (let i = 0; i < count; i++) items.push(readItem(reader))
      return items
    }
    case 5: {
      const map: Record<string, unknown> = {}
      const count = info === 31 ? Infinity : reader.length(info)
      for (let i = 0; i < count; i++) {
        const key = readItem(reader)
        if (key === BREAK) {
          if (info === 31) return map
          throw new CborError('Unexpected break in a definite-length map')
        }
        map[String(key)] = readItem(reader)
      }
      return map
    }
    case 6: {
      const tag = reader.argument(info)
      const value = readItem(reader)
      if (tag === 1 && typeof value === 'number') return new Date(value > MILLISECOND_THRESHOLD ? value : value * 1000)
      if ((tag === 2 || tag === 3) && Buffer.isBuffer(value)) {
        const magnitude = value.length ? BigInt('0x' + value.toString('hex')) : 0n
        return Number(tag === 2 ? magnitude : -1n - magnitude)
      }
      return value
    }
    default: {
      if (info === 20) return false
      if (info === 21) return true
      if (info === 22) return null
      if (info === 23) return undefined
      if (info === 24) {
        reader.byte()
        return undefined
      }
      if (info === 25) {
        reader.need(2)
        const value = halfToNumber(reader.buffer.readUInt16BE(reader.offset))
        reader.offset += 2
        return value
      }
      if (info === 26) {
        reader.need(4)
        const value = reader.buffer.readFloatBE(reader.offset)
        reader.offset += 4
        return value
      }
      if (info === 27) {
        reader.need(8)
        const value = reader.buffer.readDoubleBE(reader.offset)
        reader.offset += 8
        return value
      }
      if (info === 31) return BREAK
      if (info < 20) return undefined
      throw new CborError(`Invalid simple value ${info}`)
    }
  }
}

export function decodeCbor(buffer: Buffer): unknown {
  const value = readItem(new Reader(buffer))
  if (value === BREAK) throw new CborError('Unexpected break')
  return value
}

function head(major: number, value: number | bigint, out: Buffer[]) {
  const prefix = major << 5
  if (typeof value === 'number' && value < 24) out.push(Buffer.from([prefix | value]))
  else if (typeof value === 'number' && value < 0x100) out.push(Buffer.from([prefix | 24, value]))
  else if (typeof value === 'number' && value < 0x10000) {
    const buffer = Buffer.alloc(3)
    buffer[0] = prefix | 25
    buffer.writeUInt16BE(value, 1)
    out.push(buffer)
  } else if (typeof value === 'number' && value < 0x100000000) {
    const buffer = Buffer.alloc(5)
    buffer[0] = prefix | 26
    buffer.writeUInt32BE(value, 1)
    out.push(buffer)
  } else {
    const buffer = Buffer.alloc(9)
    buffer[0] = prefix | 27
    buffer.writeBigUInt64BE(BigInt(value), 1)
    out.push(buffer)
  }
}

function writeItem(value: unknown, out: Buffer[]) {
  if (value === null || value === undefined) {
    out.push(Buffer.from([0xf6]))
  } else if (typeof value === 'boolean') {
    out.push(Buffer.from([value ? 0xf5 : 0xf4]))
  } else if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) {
      if (value >= 0) head(0, value, out)
      else head(1, -1 - value, out)
    } else {
      const buffer = Buffer.alloc(9)
      buffer[0] = 0xfb
      buffer.writeDoubleBE(value, 1)
      out.push(buffer)
    }
  } else if (typeof value === 'bigint') {
    if (value >= 0n) head(0, value, out)
    else head(1, -1n - value, out)
  } else if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    head(3, bytes.length, out)
    out.push(bytes)
  } else if (value instanceof Uint8Array) {
    head(2, value.length, out)
    out.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  } else if (Array.isArray(value)) {
    head(4, value.length, out)
    for (const item of value) writeItem(item, out)
  } else if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined)
    head(5, entries.length, out)
    for (const [key, child] of entries) {
      writeItem(key, out)
      writeItem(child, out)
    }
  } else {
    throw new CborError(`Cannot encode ${typeof value}`)
  }
}

export function encodeCbor(value: unknown): Buffer {
  const out: Buffer[] = []
  writeItem(value, out)
  return Buffer.concat(out)
}
