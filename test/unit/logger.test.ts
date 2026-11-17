import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Logger, type LogLevel } from '../../src/logger.ts'

function capture(level: LogLevel) {
  const lines: string[] = []
  return { logger: new Logger(level, line => lines.push(line)), lines }
}

describe('logger', () => {
  it('writes the levels at or above its own level', () => {
    const { logger, lines } = capture('warn')
    for (const level of ['error', 'warn', 'info', 'debug', 'trace'] as const) logger.log(level, { level })
    assert.deepEqual(lines.map(line => JSON.parse(line).level), ['error', 'warn'])
    assert.equal(logger.enabled('info'), false)
    assert.equal(new Logger('trace', () => {}).enabled('trace'), true)
  })

  it('writes one JSON object per line, with blobs as base64 and big integers as strings', () => {
    const { logger, lines } = capture('info')
    logger.log('info', { requestId: 'a', omitted: undefined, request: { Data: Buffer.from('cbor'), Bytes: new Uint8Array([1, 2]), Count: 2n ** 64n } })
    assert.equal(lines.length, 1)
    assert.ok(lines[0]!.endsWith('}\n'))
    assert.equal(lines[0]!.indexOf('\n'), lines[0]!.length - 1)
    const entry = JSON.parse(lines[0]!)
    assert.deepEqual(Object.keys(entry), ['time', 'level', 'requestId', 'request'])
    assert.deepEqual(entry.request, { Data: 'Y2Jvcg==', Bytes: 'AQI=', Count: '18446744073709551616' })
  })

  it('refuses an unknown level', () => {
    assert.throws(() => new Logger('verbose' as LogLevel), /Unknown log level verbose/)
  })
})
