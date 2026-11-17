import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_EXPANDED_TEMPLATE_LENGTH, objectKey, validateKeyTemplate, type KeyValues } from '../../src/delivery/key-template.ts'
import { KinesisError } from '../../src/errors.ts'

const SUFFIX = '-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

const values: KeyValues = {
  channelName: 'my-channel',
  channelId: 'abc123def456',
  streamName: 'my-stream',
  compressionType: 'GZIP',
  time: new Date('2026-07-20T14:30:45Z'),
}

function failure(template: string, compressionType = 'NONE', overrides: Partial<KeyValues> = {}) {
  try {
    validateKeyTemplate(template, { ...values, ...overrides, compressionType })
  } catch (error) {
    assert.ok(error instanceof KinesisError)
    assert.equal(error.type, 'InvalidArgumentException')
    return error.message
  }
  return null
}

describe('key template checks', () => {
  it('rejects the templates that break the documented rules', () => {
    assert.match(failure('data/./!{channel-name}')!, /path traversal/)
    assert.match(failure('data/x!{extension}!{extension:.json}')!, /more than one extension placeholder/)
    assert.match(failure('data/!{channel-name}!{extension:.JSON}')!, /unsupported variable !\{extension:\.JSON\}/)
    assert.match(failure('data/!{constructor}')!, /unsupported variable !\{constructor\}/)
    assert.match(failure('data/!{yyyy/!{MM}')!, /without a closing brace/)
    assert.match(failure('data/{yyyy}')!, /contains \{ outside a variable placeholder/)
    assert.match(failure('data:!{yyyy}')!, /contains : outside a variable placeholder/)
  })

  it('accepts a template whose expansion stays within the limit', () => {
    assert.equal(failure('a'.repeat(MAX_EXPANDED_TEMPLATE_LENGTH)), null)
    assert.match(failure('a'.repeat(MAX_EXPANDED_TEMPLATE_LENGTH + 1))!, /expands to 987 characters/)
    const channelName = 'c'.repeat(128)
    assert.match(failure('!{channel-name}/'.repeat(8), 'NONE', { channelName })!, /expands to 1032 characters/)
  })
})

describe('object keys', () => {
  it('expands the default template when the channel does not set one', () => {
    assert.match(
      objectKey(undefined, values),
      new RegExp(`^kinesis-channel/my-channel/abc123def456/2026/07/20/14/my-channel-abc123def456-2026-07-20-14-30${SUFFIX}\\.gz$`),
    )
  })

  it('expands every variable in UTC', () => {
    const template = '!{channel-name}/!{channel-id}/!{stream-name}/!{yyyy}/!{yy}/!{MM}/!{dd}/!{HH}/!{mm}!{extension}'
    const time = new Date('2026-01-01T23:05:00-05:00')
    assert.match(objectKey(template, { ...values, time }), new RegExp(`^my-channel/abc123def456/my-stream/2026/26/01/02/04/05${SUFFIX}\\.gz$`))
  })

  it('derives the extension from the compression type or the literal in the template', () => {
    assert.match(objectKey('data/x!{extension}', { ...values, compressionType: 'ZSTD' }), new RegExp(`^data/x${SUFFIX}\\.zst$`))
    assert.match(objectKey('data/x!{extension}', { ...values, compressionType: 'NONE' }), new RegExp(`^data/x${SUFFIX}$`))
    assert.match(objectKey('data/x!{extension:.json}', values), new RegExp(`^data/x${SUFFIX}\\.json$`))
    assert.match(objectKey('!{channel-name}/!{channel-id}', values), new RegExp(`^my-channel/abc123def456${SUFFIX}$`))
  })

  it('gives two objects in the same minute different keys with a suffix of at most 38 characters', () => {
    const first = objectKey('data/x', values)
    const second = objectKey('data/x', values)
    assert.notEqual(first, second)
    assert.ok(first.length - 'data/x'.length <= 38)
  })
})
