import { createHash, createHmac } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface Credentials {
  accessKeyId: string
  secretAccessKey: string
}

export interface S3Client {
  endpoint: string
  region: string
  credentials: Credentials
}

export interface S3Object {
  bucket: string
  key: string
  body: Buffer | string
  headers?: Record<string, string>
}

export interface SignableRequest {
  method: string
  path: string
  query?: Record<string, string>
  headers: Record<string, string>
}

export class S3Error extends Error {
  readonly statusCode: number
  readonly code: string | undefined

  constructor(statusCode: number, code: string | undefined, message: string) {
    super(message)
    this.name = 'S3Error'
    this.statusCode = statusCode
    this.code = code
  }
}

function uriEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function encodePath(path: string) {
  return path.split('/').map(uriEncode).join('/')
}

function sha256(data: Buffer | string) {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: Buffer | string, data: string) {
  return createHmac('sha256', key).update(data).digest()
}

function byName(a: { name: string }, b: { name: string }) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function canonicalQuery(query: Record<string, string>) {
  return Object.entries(query)
    .map(([name, value]) => ({ name: uriEncode(name), value: uriEncode(value) }))
    .sort(byName)
    .map(({ name, value }) => `${name}=${value}`)
    .join('&')
}

function canonicalHeaders(headers: Record<string, string>) {
  return Object.entries(headers)
    .map(([name, value]) => ({ name: name.toLowerCase(), value: value.trim().replace(/\s+/g, ' ') }))
    .sort(byName)
}

function headerValue(headers: { name: string, value: string }[], name: string) {
  const value = headers.find(header => header.name === name)?.value
  if (value === undefined) throw new Error(`A signed S3 request needs the ${name} header.`)
  return value
}

export function authorization(request: SignableRequest, region: string, credentials: Credentials) {
  const headers = canonicalHeaders(request.headers)
  const timestamp = headerValue(headers, 'x-amz-date')
  const date = timestamp.slice(0, 8)
  const scope = `${date}/${region}/s3/aws4_request`
  const signedHeaders = headers.map(({ name }) => name).join(';')
  const canonicalRequest = [
    request.method,
    encodePath(request.path),
    canonicalQuery(request.query ?? {}),
    headers.map(({ name, value }) => `${name}:${value}\n`).join(''),
    signedHeaders,
    headerValue(headers, 'x-amz-content-sha256'),
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256(canonicalRequest)].join('\n')
  const signingKey = [date, region, 's3', 'aws4_request'].reduce<Buffer | string>(hmac, `AWS4${credentials.secretAccessKey}`)
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`
}

function xmlElement(xml: string, name: string) {
  return xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]
}

function uploadError(statusCode: number, body: string, object: S3Object) {
  const code = xmlElement(body, 'Code')
  const detail = xmlElement(body, 'Message')
  let message = `PutObject ${object.bucket}/${object.key} failed with status ${statusCode}`
  if (code) message += ` and error code ${code}`
  if (detail) message += `: ${detail}`
  return new S3Error(statusCode, code, message)
}

export function putObject(client: S3Client, object: S3Object) {
  const url = new URL(client.endpoint)
  const path = `${decodeURIComponent(url.pathname).replace(/\/+$/, '')}/${object.bucket}/${object.key}`
  const body = typeof object.body === 'string' ? Buffer.from(object.body) : object.body
  const headers: Record<string, string> = {
    ...object.headers,
    host: url.host,
    'content-length': String(body.length),
    'x-amz-content-sha256': sha256(body),
    'x-amz-date': new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''),
  }
  headers.authorization = authorization({ method: 'PUT', path, headers }, client.region, client.credentials)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<void>((resolve, reject) => {
    const req = send(url, { method: 'PUT', path: encodePath(path), headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const statusCode = res.statusCode ?? 0
        if (statusCode >= 200 && statusCode < 300) resolve()
        else reject(uploadError(statusCode, Buffer.concat(chunks).toString('utf8'), object))
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}
