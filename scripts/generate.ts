import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Bounds, Member, Operation, Shape } from '../src/model.ts'

interface SmithyTarget {
  target: string
  traits?: Record<string, unknown>
}

interface SmithyShape {
  type: string
  members?: Record<string, SmithyTarget>
  member?: SmithyTarget
  key?: SmithyTarget
  value?: SmithyTarget
  input?: SmithyTarget
  output?: SmithyTarget
  errors?: SmithyTarget[]
  operations?: SmithyTarget[]
  traits?: Record<string, unknown>
}

const modelPath = fileURLToPath(new URL('../model/kinesis-2013-12-02.json', import.meta.url))
const outputDir = fileURLToPath(new URL('../src/generated/', import.meta.url))
const model = JSON.parse(readFileSync(modelPath, 'utf8')) as { shapes: Record<string, SmithyShape> }
const preludeTypes: Record<string, Shape> = {
  'smithy.api#String': { type: 'string' },
  'smithy.api#Boolean': { type: 'boolean' },
  'smithy.api#PrimitiveBoolean': { type: 'boolean' },
  'smithy.api#Integer': { type: 'integer' },
  'smithy.api#PrimitiveInteger': { type: 'integer' },
  'smithy.api#Long': { type: 'long' },
  'smithy.api#PrimitiveLong': { type: 'long' },
  'smithy.api#Double': { type: 'double' },
  'smithy.api#Blob': { type: 'blob' },
  'smithy.api#Timestamp': { type: 'timestamp' },
}

function shortName(id: string) {
  return id.startsWith('smithy.api#') ? `smithy.${id.slice('smithy.api#'.length)}` : id.slice(id.indexOf('#') + 1)
}

function bounds(traits: Record<string, unknown> | undefined, name: string): Bounds | undefined {
  const value = traits?.[name] as Bounds | undefined
  if (!value) return undefined
  const result: Bounds = {}
  if (value.min !== undefined) result.min = value.min
  if (value.max !== undefined) result.max = value.max
  return result
}

const shapes: Record<string, Shape> = {}

function visit(id: string): string {
  const name = shortName(id)
  if (name in shapes) return name
  const prelude = preludeTypes[id]
  if (prelude) {
    shapes[name] = prelude
    return name
  }
  const shape = model.shapes[id]
  if (!shape) throw new Error(`Unknown shape ${id}`)
  const traits = shape.traits
  switch (shape.type) {
    case 'structure':
    case 'union': {
      const members: Member[] = []
      shapes[name] = { type: shape.type, members }
      for (const [memberName, member] of Object.entries(shape.members ?? {})) {
        members.push({ name: memberName, target: visit(member.target), required: 'smithy.api#required' in (member.traits ?? {}) })
      }
      return name
    }
    case 'list': {
      const list: Shape & { type: 'list' } = { type: 'list', member: '', ...lengthOf(traits) }
      shapes[name] = list
      list.member = visit(shape.member!.target)
      return name
    }
    case 'map': {
      const map: Shape & { type: 'map' } = { type: 'map', key: '', value: '', ...lengthOf(traits) }
      shapes[name] = map
      map.key = visit(shape.key!.target)
      map.value = visit(shape.value!.target)
      return name
    }
    case 'enum':
      shapes[name] = {
        type: 'string',
        enum: Object.values(shape.members ?? {}).map(member => member.traits?.['smithy.api#enumValue'] as string),
      }
      return name
    case 'string': {
      const pattern = traits?.['smithy.api#pattern'] as string | undefined
      shapes[name] = { type: 'string', ...lengthOf(traits), ...(pattern ? { pattern } : {}) }
      return name
    }
    case 'integer':
    case 'long':
    case 'double': {
      const range = bounds(traits, 'smithy.api#range')
      shapes[name] = { type: shape.type, ...(range ? { range } : {}) }
      return name
    }
    case 'blob':
      shapes[name] = { type: 'blob', ...lengthOf(traits) }
      return name
    case 'boolean':
    case 'timestamp':
      shapes[name] = { type: shape.type }
      return name
    default:
      throw new Error(`Unsupported shape type ${shape.type} for ${id}`)
  }
}

function lengthOf(traits: Record<string, unknown> | undefined) {
  const length = bounds(traits, 'smithy.api#length')
  return length ? { length } : {}
}

const service = Object.entries(model.shapes).find(([, shape]) => shape.type === 'service')
if (!service) throw new Error('The model has no service shape')
const [serviceId, serviceShape] = service
const operations: Record<string, Operation> = {}
for (const { target } of [...serviceShape.operations!].sort((a, b) => a.target.localeCompare(b.target))) {
  const operation = model.shapes[target]!
  operations[shortName(target)] = {
    input: visit(operation.input!.target),
    output: operation.output!.target === 'smithy.api#Unit' ? null : visit(operation.output!.target),
    errors: (operation.errors ?? []).map(error => shortName(error.target)),
  }
}

const sortedShapes = Object.fromEntries(Object.entries(shapes).sort(([a], [b]) => a.localeCompare(b)))
const source = [
  `import type { Operation, Shape } from '../model.ts'`,
  '',
  `export const serviceTarget = ${JSON.stringify(shortName(serviceId))}`,
  '',
  `export const operations: Record<string, Operation> = ${JSON.stringify(operations)}`,
  '',
  `export const shapes: Record<string, Shape> = ${JSON.stringify(sortedShapes)}`,
  '',
].join('\n')

mkdirSync(outputDir, { recursive: true })
writeFileSync(`${outputDir}model.ts`, source)
console.log(`Generated ${Object.keys(operations).length} operations and ${Object.keys(shapes).length} shapes`)
