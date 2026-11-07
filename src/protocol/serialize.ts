import { shapes } from '../generated/model.ts'
import { encodeCbor } from './cbor.ts'

export type Protocol = 'json' | 'cbor'

export const AMZ_JSON = 'application/x-amz-json-1.1'
export const AMZ_CBOR = 'application/x-amz-cbor-1.1'

function convert(value: unknown, shapeName: string, protocol: Protocol): unknown {
  if (value === undefined || value === null) return value
  const shape = shapes[shapeName]
  if (!shape) return value
  switch (shape.type) {
    case 'timestamp':
      return protocol === 'cbor' ? Math.round((value as number) * 1000) : value
    case 'blob':
      return protocol === 'cbor' ? value : Buffer.from(value as Uint8Array).toString('base64')
    case 'list':
      return (value as unknown[]).map(item => convert(item, shape.member, protocol))
    case 'map': {
      const result: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) result[key] = convert(child, shape.value, protocol)
      return result
    }
    case 'structure':
    case 'union': {
      const input = value as Record<string, unknown>
      const result: Record<string, unknown> = {}
      const known = new Map(shape.members.map(member => [member.name, member.target]))
      for (const [key, child] of Object.entries(input)) {
        if (child === undefined) continue
        const target = known.get(key)
        if (target) result[key] = convert(child, target, protocol)
      }
      return result
    }
    default:
      return value
  }
}

export function serializeShape(value: unknown, shapeName: string | null, protocol: Protocol) {
  return shapeName ? convert(value, shapeName, protocol) : value
}

export function encodeBody(value: unknown, protocol: Protocol): Buffer {
  if (value === undefined || value === null) return Buffer.alloc(0)
  return protocol === 'cbor' ? encodeCbor(value) : Buffer.from(JSON.stringify(value), 'utf8')
}
