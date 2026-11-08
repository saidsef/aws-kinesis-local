import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2'
import { KinesisError } from './errors.ts'
import { operations, serviceTarget } from './generated/model.ts'
import { handlers } from './operations/index.ts'
import { DEFAULT_MAX_RECORD_SIZE_KIB, streamNameFromArn, type Context } from './operations/common.ts'
import { Subscription } from './operations/subscribe.ts'
import { decodeCbor } from './protocol/cbor.ts'
import { AMZ_CBOR, AMZ_JSON, encodeBody, serializeShape, type Protocol } from './protocol/serialize.ts'
import type { Store } from './store/store.ts'
import { coerceStructure, decodeBlobs, validateStructure, type ValidationContext } from './validation/validate.ts'

const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const EVENT_STREAM = 'application/vnd.amazon.eventstream'
const HEALTH_PATHS = ['/healthz', '/readyz']
const EXPOSED_HEADERS = 'x-amzn-RequestId,x-amzn-ErrorType,x-amz-request-id,x-amz-id-2,x-amzn-ErrorMessage,Date'

type Request = IncomingMessage | Http2ServerRequest
type Response = ServerResponse | Http2ServerResponse

interface Exchange {
  req: Request
  res: ServerResponse
  contentType: string
}

function header(req: Request, name: string) {
  const value = req.headers[name]
  return Array.isArray(value) ? value.join(',') : value ?? ''
}

function sendRaw(exchange: Exchange, body: Buffer | string | null, statusCode = 200) {
  const { req, res } = exchange
  req.removeAllListeners('data')
  res.statusCode = statusCode
  if (body === null) return res.end()
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function protocolOf(exchange: Exchange): Protocol {
  return exchange.contentType === AMZ_CBOR ? 'cbor' : 'json'
}

function sendResponse(exchange: Exchange, data: unknown, statusCode = 200) {
  exchange.res.setHeader('Content-Type', exchange.contentType)
  sendRaw(exchange, encodeBody(data, protocolOf(exchange)), statusCode)
}

function sendError(exchange: Exchange, contentValid: boolean, type: string, message: string | number) {
  if (contentValid) return sendResponse(exchange, { __type: type, message }, 400)
  if (typeof message === 'number') return sendRaw(exchange, `<${type}/>\n`, message)
  return sendRaw(exchange, `<${type}>\n  <Message>${message}</Message>\n</${type}>\n`, 403)
}

function sendHealth(store: Store, exchange: Exchange, path: string) {
  const healthy = store.healthy() && (path === '/healthz' || !store.draining)
  exchange.res.setHeader('Content-Type', 'text/plain')
  sendRaw(exchange, healthy ? 'ok\n' : 'unavailable\n', healthy ? 200 : 503)
}

function validationContext(store: Store, data: Record<string, unknown>): ValidationContext {
  let name = typeof data.StreamName === 'string' ? data.StreamName : undefined
  if (name === undefined && typeof data.StreamARN === 'string') name = streamNameFromArn(data.StreamARN)
  const stream = name === undefined ? undefined : store.streams.get(name)
  return {
    partitionKeyRequired: stream?.RecordDistributionStrategy !== 'AUTO',
    maxRecordBytes: (stream?.MaxRecordSizeInKiB ?? DEFAULT_MAX_RECORD_SIZE_KIB) * 1024,
  }
}

function checkAuthentication(exchange: Exchange) {
  const { req } = exchange
  const authHeader = header(req, 'authorization')
  const url = new URL(req.url ?? '/', 'http://localhost')
  const query = url.searchParams
  const authQuery = query.has('X-Amz-Algorithm')
  if (authHeader && authQuery) {
    return new KinesisError('InvalidSignatureException', 'Found both \'X-Amz-Algorithm\' as a query-string param and \'Authorization\' as HTTP header.')
  }
  if (!authHeader && !authQuery) return new KinesisError('MissingAuthenticationTokenException', 'Missing Authentication Token')
  let message = ''
  if (authHeader) {
    const params: Record<string, string | undefined> = {}
    for (const part of authHeader.split(/,| /).slice(1).filter(Boolean)) {
      const [key, value] = part.trim().split('=')
      params[key!] = value
    }
    for (const param of ['Credential', 'Signature', 'SignedHeaders']) {
      if (!params[param]) message += `Authorization header requires '${param}' parameter. `
    }
    if (!header(req, 'x-amz-date') && !header(req, 'date')) {
      message += 'Authorization header requires existence of either a \'X-Amz-Date\' or a \'Date\' header. '
    }
    if (message) message += `Authorization=${authHeader}`
  } else {
    for (const param of ['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Signature', 'X-Amz-SignedHeaders', 'X-Amz-Date']) {
      if (!query.get(param)) message += `AWS query-string parameters must include '${param}'. `
    }
    if (message) message += 'Re-examine the query-string parameters.'
  }
  return message ? new KinesisError('IncompleteSignatureException', message) : null
}

function streamEvents(exchange: Exchange, subscription: Subscription) {
  const { req, res } = exchange
  req.removeAllListeners('data')
  res.statusCode = 200
  res.setHeader('Content-Type', EVENT_STREAM)
  const closeListeners: (() => void)[] = []
  let ended = false
  const closed = () => {
    if (ended) return
    ended = true
    for (const listener of closeListeners) listener()
  }
  res.on('close', closed)
  subscription.start({
    write: chunk => {
      if (!ended) res.write(chunk)
    },
    end: () => {
      if (!ended) {
        ended = true
        res.end()
      }
    },
    onClose: listener => {
      closeListeners.push(listener)
    },
  })
}

function dispatch(store: Store, exchange: Exchange, operation: string, input: Record<string, unknown>) {
  const definition = operations[operation]!
  const context: Context = { store, protocol: protocolOf(exchange) }
  let data = coerceStructure(input, definition.input)
  validateStructure(data, definition.input, validationContext(store, data))
  data = decodeBlobs(data, definition.input) as Record<string, unknown>
  const result = handlers[operation]!(context, data)
  if (result instanceof Subscription) return streamEvents(exchange, result)
  sendResponse(exchange, result === undefined ? undefined : serializeShape(result, definition.output, context.protocol))
}

function respond(store: Store, exchange: Exchange, body: Buffer | undefined) {
  const { req, res } = exchange
  res.setHeader('x-amzn-RequestId', randomUUID())
  if (req.method !== 'OPTIONS' || !req.headers.origin) res.setHeader('x-amz-id-2', randomBytes(72).toString('base64'))
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'OPTIONS') {
      const requestHeaders = header(req, 'access-control-request-headers')
      const requestMethod = header(req, 'access-control-request-method')
      if (requestHeaders) res.setHeader('Access-Control-Allow-Headers', requestHeaders)
      if (requestMethod) res.setHeader('Access-Control-Allow-Methods', requestMethod)
      res.setHeader('Access-Control-Max-Age', 172800)
      return sendRaw(exchange, '')
    }
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS)
  }
  const path = req.url?.split('?')[0] ?? ''
  if (req.method === 'GET' && HEALTH_PATHS.includes(path)) return sendHealth(store, exchange, path)
  if (req.method !== 'POST') {
    return sendError(exchange, false, 'AccessDeniedException', 'Unable to determine service/operation name to be authorized')
  }
  const contentType = header(req, 'content-type').split(';')[0]!.trim()
  const contentValid = [AMZ_JSON, AMZ_CBOR, 'application/json'].includes(contentType)
  const [service, operation] = header(req, 'x-amz-target').split('.')
  const serviceValid = !!service && service === serviceTarget
  const operationValid = !!operation && Object.hasOwn(handlers, operation)
  if (!body) {
    exchange.contentType = contentType === AMZ_JSON ? AMZ_JSON : AMZ_CBOR
    return sendResponse(exchange, { __type: serviceValid && operationValid ? 'SerializationException' : 'UnknownOperationException' }, 400)
  }
  if (!contentValid) {
    if (!service || !operation) {
      return sendError(exchange, false, 'AccessDeniedException', 'Unable to determine service/operation name to be authorized')
    }
    return sendError(exchange, false, 'UnknownOperationException', 404)
  }
  exchange.contentType = contentType
  let data: unknown
  try {
    data = contentType === AMZ_CBOR ? decodeCbor(body) : JSON.parse(body.toString('utf8'))
  } catch {
    data = undefined
  }
  if (typeof data !== 'object' || data === null) {
    if (contentType === 'application/json') {
      return sendResponse(exchange, { Output: { __type: 'com.amazon.coral.service#SerializationException' }, Version: '1.0' }, 400)
    }
    return sendResponse(exchange, { __type: 'SerializationException' }, 400)
  }
  if (contentType === 'application/json') {
    return sendResponse(exchange, { Output: { __type: 'com.amazon.coral.service#UnknownOperationException' }, Version: '1.0' }, 404)
  }
  if (!serviceValid || !operationValid) return sendResponse(exchange, { __type: 'UnknownOperationException' }, 400)
  const authError = checkAuthentication(exchange)
  if (authError) return sendResponse(exchange, authError.body, authError.statusCode)
  try {
    dispatch(store, exchange, operation!, data as Record<string, unknown>)
  } catch (error) {
    if (error instanceof KinesisError) return sendResponse(exchange, error.body, error.statusCode)
    console.error(error instanceof Error ? error.stack : error)
    return sendResponse(exchange, { __type: 'InternalFailure' }, 500)
  }
}

export function createHandler(store: Store) {
  return (req: Request, res: Response) => {
    const exchange: Exchange = { req, res: res as ServerResponse, contentType: AMZ_JSON }
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('error', () => res.destroy())
    req.on('data', (chunk: Buffer) => {
      if (rejected) return
      size += chunk.length
      if (size > MAX_REQUEST_BYTES) {
        rejected = true
        if (req.httpVersionMajor < 2) res.setHeader('Transfer-Encoding', 'chunked')
        sendRaw(exchange, null, 413)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (rejected) return
      respond(store, exchange, size ? Buffer.concat(chunks, size) : undefined)
    })
  }
}
