import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'

function encodeLength(length: number) {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, ...contents: Buffer[]) {
  const body = Buffer.concat(contents)
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body])
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items)
const set = (...items: Buffer[]) => tlv(0x31, ...items)

function oid(dotted: string) {
  const arcs = dotted.split('.').map(Number)
  const bytes = [40 * arcs[0]! + arcs[1]!]
  for (const arc of arcs.slice(2)) {
    const encoded = [arc & 0x7f]
    for (let value = arc >> 7; value > 0; value >>= 7) encoded.unshift((value & 0x7f) | 0x80)
    bytes.push(...encoded)
  }
  return tlv(0x06, Buffer.from(bytes))
}

function integer(value: Buffer) {
  const trimmed = value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value
  return tlv(0x02, trimmed)
}

function time(date: Date) {
  const text = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(text.slice(2), 'ascii')) : tlv(0x18, Buffer.from(text, 'ascii'))
}

function commonName(name: string) {
  return sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(name, 'utf8')))))
}

function subjectAltNames(hosts: string[], addresses: Buffer[]) {
  const names = [
    ...hosts.map(host => tlv(0x82, Buffer.from(host, 'ascii'))),
    ...addresses.map(address => tlv(0x87, address)),
  ]
  return sequence(oid('2.5.29.17'), tlv(0x04, sequence(...names)))
}

export function selfSignedCertificate(hostname = 'localhost') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const algorithm = sequence(oid('1.2.840.10045.4.3.2'))
  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)
  const serial = randomBytes(16)
  serial[0] = serial[0]! & 0x7f
  const name = commonName(hostname)
  const loopback6 = Buffer.alloc(16)
  loopback6[15] = 1
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, sequence(subjectAltNames([hostname], [Buffer.from([127, 0, 0, 1]), loopback6]))),
  )
  const signature = sign('sha256', tbs, privateKey)
  const certificate = sequence(tbs, algorithm, tlv(0x03, Buffer.from([0]), signature))
  const pem = certificate.toString('base64').match(/.{1,64}/g)!.join('\n')
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    cert: `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----\n`,
  }
}
