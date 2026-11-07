import assert from 'node:assert/strict'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { describe, it } from 'node:test'
import { numberOption, parseArguments, stringOption } from '../../src/arguments.ts'
import { selfSignedCertificate } from '../../src/certificate.ts'

describe('command-line arguments', () => {
  it('parses the flags that the image entrypoint passes', () => {
    const args = parseArguments(['--port', '4567', '--path', '/data', '--shardLimit', '50', '--createStreamMs', '50', '--deleteStreamMs=60', '--ssl'])
    assert.deepEqual(args, { port: '4567', path: '/data', shardLimit: '50', createStreamMs: '50', deleteStreamMs: '60', ssl: true })
  })

  it('treats ssl and help as switches', () => {
    assert.deepEqual(parseArguments(['--ssl', '--port', '1', '--help']), { ssl: true, port: '1', help: true })
    assert.deepEqual(parseArguments(['--no-ssl']), { ssl: false })
  })

  it('falls back to defaults for missing or invalid numbers', () => {
    assert.equal(numberOption(undefined, 500), 500)
    assert.equal(numberOption('abc', 500), 500)
    assert.equal(numberOption('0', 500), 0)
    assert.equal(stringOption(''), undefined)
    assert.equal(stringOption(true), undefined)
  })
})

describe('self-signed certificate', () => {
  it('is a valid certificate for localhost and the loopback addresses', () => {
    const { key, cert } = selfSignedCertificate()
    const certificate = new X509Certificate(cert)
    assert.ok(certificate.checkPrivateKey(createPrivateKey(key)))
    assert.ok(certificate.verify(certificate.publicKey))
    assert.equal(certificate.checkHost('localhost'), 'localhost')
    assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1')
    assert.ok(new Date(certificate.validTo) > new Date(Date.now() + 365 * 24 * 60 * 60 * 1000))
  })
})
