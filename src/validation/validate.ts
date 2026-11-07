import { serializationError, validationError } from '../errors.ts'
import { shapes } from '../generated/model.ts'
import type { Member, Shape } from '../model.ts'
import {
  enumOrder, listMemberLabels, memberOrder, partitionKeyShapes, recordDataShapes, streamNameOptional,
} from './member-order.ts'

export interface ValidationContext {
  partitionKeyRequired: boolean
  maxRecordBytes: number
}

type Data = Record<string, unknown>
type TypeName = 'Boolean' | 'Integer' | 'Long' | 'Double' | 'String' | 'Blob' | 'Timestamp' | 'List' | 'Map' | 'Structure'

const MAX_ERRORS = 10

function shapeOf(name: string): Shape {
  const shape = shapes[name]
  if (!shape) throw new Error(`Unknown shape ${name}`)
  return shape
}

function typeNameOf(shape: Shape): TypeName {
  switch (shape.type) {
    case 'boolean': return 'Boolean'
    case 'integer': return 'Integer'
    case 'long': return 'Long'
    case 'double': return 'Double'
    case 'string': return 'String'
    case 'blob': return 'Blob'
    case 'timestamp': return 'Timestamp'
    case 'list': return 'List'
    case 'map': return 'Map'
    default: return 'Structure'
  }
}

function membersOf(name: string): Member[] {
  const shape = shapeOf(name)
  if (shape.type !== 'structure' && shape.type !== 'union') return []
  const order = memberOrder[name]
  if (!order) return shape.members
  const byName = new Map(shape.members.map(member => [member.name, member]))
  const first = order.map(member => byName.get(member)).filter((member): member is Member => member !== undefined)
  return [...first, ...shape.members.filter(member => !order.includes(member.name))]
}

function isPlainObject(value: unknown): value is Data {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof Date)
}

function objectError(value: object) {
  return serializationError(Array.isArray(value) ? 'Start of list found where not expected' : 'Start of structure or map found where not expected.')
}

const BIG_NUMBER = 'class com.amazon.coral.value.json.numbers.TruncatingBigNumber'

function coerce(value: unknown, shapeName: string): unknown {
  if (value === null || value === undefined) return null
  const shape = shapeOf(shapeName)
  const type = typeNameOf(shape)
  switch (type) {
    case 'Boolean':
      if (typeof value === 'number') throw serializationError(`${BIG_NUMBER} can not be converted to an Boolean`)
      if (typeof value === 'string') throw serializationError(`'${value.toUpperCase()}' can not be converted to an Boolean`)
      if (typeof value === 'object') throw objectError(value)
      return value
    case 'Integer':
    case 'Long':
    case 'Double':
      if (typeof value === 'boolean') throw serializationError(`class java.lang.Boolean can not be converted to an ${type}`)
      if (typeof value === 'string') throw serializationError(`class java.lang.String can not be converted to an ${type}`)
      if (typeof value === 'object') throw objectError(value)
      if (typeof value === 'number') {
        if (type === 'Double') return value
        const floored = Math.floor(value)
        return type === 'Integer' ? Math.min(floored, 2147483647) : floored
      }
      return value
    case 'String':
      if (typeof value === 'boolean') throw serializationError('class java.lang.Boolean can not be converted to an String')
      if (typeof value === 'number') throw serializationError(`${BIG_NUMBER} can not be converted to an String`)
      if (typeof value === 'object') throw objectError(value)
      return value
    case 'Blob': {
      if (typeof value === 'boolean') throw serializationError('class java.lang.Boolean can not be converted to a Blob')
      if (typeof value === 'number') throw serializationError(`${BIG_NUMBER} can not be converted to a Blob`)
      if (Buffer.isBuffer(value)) return value
      if (typeof value === 'object') throw objectError(value)
      const text = String(value)
      if (text.length % 4) {
        throw serializationError(`'${text}' can not be converted to a Blob: Base64 encoded length is expected a multiple of 4 bytes but found: ${text.length}`)
      }
      const invalid = text.match(/[^a-zA-Z0-9+/=]|=[^=]/)
      if (invalid) throw serializationError(`'${text}' can not be converted to a Blob: Invalid Base64 character: '${invalid[0][0]}'`)
      if (Buffer.from(text, 'base64').toString('base64') !== text) {
        throw serializationError(`'${text}' can not be converted to a Blob: Invalid last non-pad Base64 character dectected`)
      }
      return text
    }
    case 'Timestamp':
      if (typeof value === 'boolean') throw serializationError('class java.lang.Boolean can not be converted to milliseconds since epoch')
      if (typeof value === 'string') throw serializationError('class java.lang.String can not be converted to milliseconds since epoch')
      if (value instanceof Date) return value.getTime() / 1000
      if (typeof value === 'object') throw objectError(value)
      return value
    case 'List': {
      if (typeof value !== 'object') throw serializationError('Expected list or null')
      if (!Array.isArray(value)) throw serializationError('Start of structure or map found where not expected.')
      const member = (shape as Shape & { type: 'list' }).member
      return value.map(item => coerce(item, member))
    }
    case 'Map': {
      if (typeof value !== 'object') throw serializationError('Expected map or null')
      if (Array.isArray(value) || Buffer.isBuffer(value) || value instanceof Date) throw serializationError('Start of list found where not expected')
      const valueShape = (shape as Shape & { type: 'map' }).value
      const result: Data = {}
      for (const [key, child] of Object.entries(value as Data)) {
        const converted = coerce(child, valueShape)
        if (converted !== null) result[key] = converted
      }
      return result
    }
    case 'Structure':
      if (typeof value !== 'object') throw serializationError('Expected null')
      if (Array.isArray(value)) throw serializationError('Start of list found where not expected')
      if (!isPlainObject(value)) throw serializationError('Start of structure or map found where not expected.')
      return coerceStructure(value, shapeName)
  }
}

export function coerceStructure(data: Data, shapeName: string): Data {
  const result: Data = {}
  for (const member of membersOf(shapeName)) {
    if (!Object.hasOwn(data, member.name)) continue
    const value = coerce(data[member.name], member.target)
    if (value !== null) result[member.name] = value
  }
  return result
}

interface Rules {
  type: TypeName
  notNull?: boolean
  regex?: string
  lengthGreaterThanOrEqual?: number
  lengthLessThanOrEqual?: number
  greaterThanOrEqual?: number
  lessThanOrEqual?: number
  enum?: string[]
  childLengths?: [number, number]
  childEnum?: string[]
  childKeyLengths?: [number, number]
  childValueLengths?: [number, number]
  memberLabel?: string
}

function displayPattern(pattern: string) {
  let display = pattern.replace(/^\^/, '').replace(/\$$/, '')
  if (display.startsWith('(') && display.endsWith(')')) {
    let depth = 0
    let wrapsAll = true
    for (let i = 0; i < display.length; i++) {
      if (display[i] === '\\') {
        i++
        continue
      }
      if (display[i] === '(') depth++
      if (display[i] === ')') depth--
      if (depth === 0 && i < display.length - 1) {
        wrapsAll = false
        break
      }
    }
    if (wrapsAll) display = display.slice(1, -1)
  }
  return display
}

function rulesFor(structureName: string, member: Member, data: Data, context: ValidationContext): Rules {
  const shape = shapeOf(member.target)
  const rules: Rules = { type: typeNameOf(shape) }
  const structure = shapeOf(structureName) as Shape & { type: 'structure' }
  const hasMember = (name: string) => structure.members.some(candidate => candidate.name === name)
  const modeDetails = data.StreamModeDetails as Data | undefined
  rules.notNull = member.required
    || (member.name === 'StreamName' && hasMember('StreamARN') && !streamNameOptional.has(structureName) && data.StreamARN == null)
    || (member.name === 'PartitionKey' && partitionKeyShapes.has(structureName) && context.partitionKeyRequired)
    || (structureName === 'CreateStreamInput' && member.name === 'ShardCount' && modeDetails?.StreamMode !== 'ON_DEMAND')
  if (shape.type === 'string') {
    if (shape.pattern) rules.regex = shape.pattern
    if (shape.length?.min) rules.lengthGreaterThanOrEqual = shape.length.min
    if (shape.length?.max !== undefined) rules.lengthLessThanOrEqual = shape.length.max
    if (shape.enum) rules.enum = enumOrder[member.target] ?? shape.enum
  }
  if (shape.type === 'blob') {
    if (shape.length?.min) rules.lengthGreaterThanOrEqual = shape.length.min
    if (shape.length?.max !== undefined) rules.lengthLessThanOrEqual = shape.length.max
    if (member.name === 'Data' && recordDataShapes.has(structureName)) rules.lengthLessThanOrEqual = context.maxRecordBytes
  }
  if (shape.type === 'integer' || shape.type === 'long' || shape.type === 'double') {
    if (shape.range?.min !== undefined) rules.greaterThanOrEqual = shape.range.min
    if (shape.range?.max !== undefined) rules.lessThanOrEqual = shape.range.max
  }
  if (shape.type === 'list') {
    if (shape.length?.min) rules.lengthGreaterThanOrEqual = shape.length.min
    if (shape.length?.max !== undefined) rules.lengthLessThanOrEqual = shape.length.max
    const element = shapeOf(shape.member)
    if (element.type === 'string' && element.length) rules.childLengths = [element.length.min ?? 0, element.length.max ?? Infinity]
    if (element.type === 'string' && element.enum) rules.childEnum = enumOrder[shape.member] ?? element.enum
    const label = listMemberLabels[shape.member]
    if (label) rules.memberLabel = label
  }
  if (shape.type === 'map') {
    if (shape.length?.min) rules.lengthGreaterThanOrEqual = shape.length.min
    if (shape.length?.max !== undefined) rules.lengthLessThanOrEqual = shape.length.max
    const key = shapeOf(shape.key)
    const value = shapeOf(shape.value)
    if (key.type === 'string' && key.length) rules.childKeyLengths = [key.length.min ?? 0, key.length.max ?? Infinity]
    if (value.type === 'string' && value.length) rules.childValueLengths = [value.length.min ?? 0, value.length.max ?? Infinity]
  }
  return rules
}

function lowerFirst(text: string) {
  return text[0]!.toLowerCase() + text.slice(1)
}

function lengthOf(value: unknown, type: TypeName) {
  if (type === 'Blob') return typeof value === 'string' ? Buffer.from(value, 'base64').length : (value as Buffer).length
  if (isPlainObject(value)) return Object.keys(value).length
  return (value as { length: number }).length
}

function valueText(value: unknown, rules: Rules) {
  if (value === null || value === undefined) return 'null'
  switch (rules.type) {
    case 'Blob': {
      const length = lengthOf(value, 'Blob')
      return `java.nio.HeapByteBuffer[pos=0 lim=${length} cap=${length}]`
    }
    case 'List':
      return '[' + (value as unknown[]).map(item => rules.memberLabel ?? (isPlainObject(item) ? JSON.stringify(item) : String(item))).join(', ') + ']'
    case 'Map':
      return '{' + Object.entries(value as Data).map(([key, child]) => `${key}=${String(child)}`).join(', ') + '}'
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
}

function bounds(min: number, max: number) {
  return `[Member must have length less than or equal to ${max}, Member must have length greater than or equal to ${min}]`
}

function checkMember(attr: string, value: unknown, member: Member, rules: Rules, parent: string, errors: string[], context: ValidationContext) {
  const report = (passed: boolean, message: string) => {
    if (passed) return
    const shown = valueText(value, rules)
    errors.push(`Value ${shown === 'null' ? 'null' : `'${shown}'`} at '${parent ? parent + '.' : ''}${lowerFirst(attr)}' failed to satisfy constraint: ${message}`)
  }
  const checks: [keyof Rules, () => void][] = [
    ['notNull', () => report(value != null, 'Member must not be null')],
    ['regex', () => report(new RegExp(rules.regex!).test(value as string), `Member must satisfy regular expression pattern: ${displayPattern(rules.regex!)}`)],
    ['lengthGreaterThanOrEqual', () => report(lengthOf(value, rules.type) >= rules.lengthGreaterThanOrEqual!, `Member must have length greater than or equal to ${rules.lengthGreaterThanOrEqual}`)],
    ['lengthLessThanOrEqual', () => report(lengthOf(value, rules.type) <= rules.lengthLessThanOrEqual!, `Member must have length less than or equal to ${rules.lengthLessThanOrEqual}`)],
    ['greaterThanOrEqual', () => report((value as number) >= rules.greaterThanOrEqual!, `Member must have value greater than or equal to ${rules.greaterThanOrEqual}`)],
    ['lessThanOrEqual', () => report((value as number) <= rules.lessThanOrEqual!, `Member must have value less than or equal to ${rules.lessThanOrEqual}`)],
    ['enum', () => report(rules.enum!.includes(value as string), `Member must satisfy enum value set: [${rules.enum!.join(', ')}]`)],
    ['childLengths', () => {
      const [min, max] = rules.childLengths!
      report((value as unknown[]).every(item => typeof item === 'string' && item.length >= min && item.length <= max), `Member must satisfy constraint: ${bounds(min, max)}`)
    }],
    ['childEnum', () => report((value as unknown[]).every(item => rules.childEnum!.includes(item as string)), `Member must satisfy constraint: [Member must satisfy enum value set: [${rules.childEnum!.join(', ')}]]`)],
    ['childKeyLengths', () => {
      const [min, max] = rules.childKeyLengths!
      report(Object.keys(value as Data).every(key => key.length >= min && key.length <= max), `Map keys must satisfy constraint: ${bounds(min, max)}`)
    }],
    ['childValueLengths', () => {
      const [min, max] = rules.childValueLengths!
      report(Object.values(value as Data).every(child => typeof child === 'string' && child.length >= min && child.length <= max), `Map value must satisfy constraint: ${bounds(min, max)}`)
    }],
  ]
  for (const [name, check] of checks) {
    if (errors.length >= MAX_ERRORS) return
    if (rules[name] === undefined || rules[name] === false) continue
    if (name !== 'notNull' && value == null) continue
    check()
  }
  if (value == null || errors.length >= MAX_ERRORS) return
  const path = (parent ? parent + '.' : '') + lowerFirst(attr)
  const shape = shapeOf(member.target)
  if (shape.type === 'structure' || shape.type === 'union') {
    checkStructure(isPlainObject(value) ? value : {}, member.target, path, errors, context)
  } else if (shape.type === 'list' && isStructure(shape.member)) {
    const items = value as unknown[]
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      checkStructure(isPlainObject(item) ? item : {}, shape.member, `${path}.${i + 1}.member`, errors, context)
    }
  } else if (shape.type === 'map' && isStructure(shape.value)) {
    for (const key of Object.keys(value as Data).reverse()) {
      const item = (value as Data)[key]
      checkStructure(isPlainObject(item) ? item : {}, shape.value, `${path}.${key}.member`, errors, context)
    }
  }
}

function isStructure(name: string) {
  const type = shapeOf(name).type
  return type === 'structure' || type === 'union'
}

function checkStructure(data: Data, structureName: string, parent: string, errors: string[], context: ValidationContext) {
  for (const member of membersOf(structureName)) {
    if (errors.length >= MAX_ERRORS) return
    checkMember(member.name, data[member.name], member, rulesFor(structureName, member, data, context), parent, errors, context)
  }
}

export function validateStructure(data: Data, structureName: string, context: ValidationContext) {
  const errors: string[] = []
  checkStructure(data, structureName, '', errors, context)
  if (errors.length) {
    throw validationError(`${errors.length} validation error${errors.length > 1 ? 's' : ''} detected: ${errors.join('; ')}`)
  }
}

export function decodeBlobs(value: unknown, shapeName: string): unknown {
  if (value === null || value === undefined) return value
  const shape = shapeOf(shapeName)
  switch (shape.type) {
    case 'blob':
      return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'base64')
    case 'list':
      return (value as unknown[]).map(item => decodeBlobs(item, shape.member))
    case 'map':
      return Object.fromEntries(Object.entries(value as Data).map(([key, child]) => [key, decodeBlobs(child, shape.value)]))
    case 'structure':
    case 'union': {
      const result: Data = {}
      for (const member of shape.members) {
        if ((value as Data)[member.name] !== undefined) result[member.name] = decodeBlobs((value as Data)[member.name], member.target)
      }
      return result
    }
    default:
      return value
  }
}
