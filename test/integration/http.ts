import { request, type Agent } from 'node:http'
import { decode as decodeCbor, encode as encodeCbor } from 'cbor2'

export interface RawRequest {
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: Buffer | string
  agent?: Agent
}

export interface RawResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

export const AMZ_JSON = 'application/x-amz-json-1.1'
export const AMZ_CBOR = 'application/x-amz-cbor-1.1'

export const AUTH = {
  authorization: 'AWS4-HMAC-SHA256 Credential=test/20261107/eu-west-1/kinesis/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=0000',
  'x-amz-date': '20261107T120000Z',
}

export function send(endpoint: string, raw: RawRequest): Promise<RawResponse> {
  const url = new URL(raw.path ?? '/', endpoint)
  return new Promise((resolve, reject) => {
    const req = request(url, { method: raw.method ?? 'POST', headers: raw.headers ?? {}, timeout: 15000, ...(raw.agent ? { agent: raw.agent } : {}) }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(res.headers)) headers[name] = Array.isArray(value) ? value.join(',') : String(value)
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) })
      })
    })
    req.on('timeout', () => req.destroy(new Error(`${raw.headers?.['x-amz-target'] ?? raw.method} timed out`)))
    req.on('error', reject)
    req.end(raw.body)
  })
}

export function call(endpoint: string, operation: string, body: unknown, options: { protocol?: 'json' | 'cbor', headers?: Record<string, string> } = {}) {
  const cbor = options.protocol === 'cbor'
  return send(endpoint, {
    headers: {
      'content-type': cbor ? AMZ_CBOR : AMZ_JSON,
      'x-amz-target': `Kinesis_20131202.${operation}`,
      ...AUTH,
      ...options.headers,
    },
    body: cbor ? Buffer.from(encodeCbor(body)) : JSON.stringify(body),
  })
}

export function parseBody(response: RawResponse): unknown {
  if (!response.body.length) return null
  const type = response.headers['content-type'] ?? ''
  if (type.startsWith(AMZ_CBOR)) return decodeCbor(new Uint8Array(response.body))
  if (type.startsWith(AMZ_JSON) || type.startsWith('application/json')) return JSON.parse(response.body.toString('utf8'))
  return response.body.toString('utf8')
}
