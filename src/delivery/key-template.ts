import { randomUUID } from 'node:crypto'
import { invalidArgument } from '../errors.ts'

export const DEFAULT_KEY_TEMPLATE =
  'kinesis-channel/!{channel-name}/!{channel-id}/!{yyyy}/!{MM}/!{dd}/!{HH}/!{channel-name}-!{channel-id}-!{yyyy}-!{MM}-!{dd}-!{HH}-!{mm}!{extension}'

export const MAX_EXPANDED_TEMPLATE_LENGTH = 986

const PLACEHOLDER = /!\{([^{}]*)\}/
const INVALID_LITERAL = /[^0-9A-Za-z!\-_'.*()/=]/
const LITERAL_EXTENSION = /^extension:(\.[a-z.]+)$/
const COMPRESSION_EXTENSIONS: Record<string, string> = { NONE: '', GZIP: '.gz', ZSTD: '.zst' }

export interface KeyValues {
  channelName: string
  channelId: string
  streamName: string
  compressionType: string
  time: Date
}

interface Part {
  expand: (values: KeyValues) => string
  extension?: boolean
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

const VARIABLES = new Map<string, (values: KeyValues) => string>([
  ['channel-name', values => values.channelName],
  ['channel-id', values => values.channelId],
  ['stream-name', values => values.streamName],
  ['yyyy', values => String(values.time.getUTCFullYear())],
  ['yy', values => pad(values.time.getUTCFullYear() % 100)],
  ['MM', values => pad(values.time.getUTCMonth() + 1)],
  ['dd', values => pad(values.time.getUTCDate())],
  ['HH', values => pad(values.time.getUTCHours())],
  ['mm', values => pad(values.time.getUTCMinutes())],
  ['extension', values => COMPRESSION_EXTENSIONS[values.compressionType] ?? ''],
])

function invalidTemplate(template: string, reason: string) {
  return invalidArgument(`OutputKeyTemplate ${template} ${reason}.`)
}

function variable(template: string, name: string): Part {
  const expand = VARIABLES.get(name)
  if (expand) return { expand, extension: name === 'extension' }
  const literal = LITERAL_EXTENSION.exec(name)?.[1]
  if (literal) return { expand: () => literal, extension: true }
  throw invalidTemplate(template, `uses the unsupported variable !{${name}}`)
}

function parse(template: string) {
  return template.split(PLACEHOLDER).flatMap((piece, index): Part[] => {
    if (index % 2) return [variable(template, piece)]
    if (piece.includes('!{')) throw invalidTemplate(template, 'has a variable placeholder without a closing brace')
    const invalid = INVALID_LITERAL.exec(piece)
    if (invalid) throw invalidTemplate(template, `contains ${invalid[0]} outside a variable placeholder`)
    return piece ? [{ expand: () => piece }] : []
  })
}

function expand(parts: Part[], values: KeyValues) {
  return parts.map(part => part.expand(values)).join('')
}

export function validateKeyTemplate(template: string, values: Omit<KeyValues, 'time'>) {
  if (template.startsWith('/')) throw invalidTemplate(template, 'must not start with a forward slash')
  if (template.includes('..') || template.split('/').includes('.')) throw invalidTemplate(template, 'must not contain path traversal')
  if (template.includes('//')) throw invalidTemplate(template, 'must not contain consecutive slashes')
  const parts = parse(template)
  const extensions = parts.filter(part => part.extension)
  if (extensions.length > 1) throw invalidTemplate(template, 'must not contain more than one extension placeholder')
  if (extensions.length && !parts.at(-1)?.extension) throw invalidTemplate(template, 'must end with its extension placeholder')
  if (!extensions.length && values.compressionType !== 'NONE') {
    throw invalidTemplate(template, `must end with an extension placeholder when CompressionType is ${values.compressionType}`)
  }
  const length = expand(parts, { ...values, time: new Date(0) }).length
  if (length > MAX_EXPANDED_TEMPLATE_LENGTH) {
    throw invalidTemplate(template, `expands to ${length} characters, which is more than ${MAX_EXPANDED_TEMPLATE_LENGTH}`)
  }
}

export function objectKey(template: string | undefined, values: KeyValues) {
  const parts = parse(template ?? DEFAULT_KEY_TEMPLATE)
  const extension = parts.at(-1)?.extension ? parts.pop()!.expand(values) : ''
  return `${expand(parts, values)}-${randomUUID()}${extension}`
}
