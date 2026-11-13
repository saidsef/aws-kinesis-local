import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2'
import { KinesisError } from './errors.ts'
import { operations, serviceTarget } from './generated/model.ts'
import type { Logger, LogLevel } from './logger.ts'
import { handlers } from './operations/index.ts'
import { DEFAULT_MAX_RECORD_SIZE_KIB, parseConsumerArn, streamNameFromArn, type Context } from './operations/common.ts'
import { Subscription } from './operations/subscribe.ts'
import { decodeCbor } from './protocol/cbor.ts'
import { AMZ_CBOR, AMZ_JSON, encodeBody, serializeShape, type Protocol } from './protocol/serialize.ts'
import type { Store } from './store/store.ts'
import { coerceStructure, decodeBlobs, validateStructure, type ValidationContext } from './validation/validate.ts'

const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const EVENT_STREAM = 'application/vnd.amazon.eventstream'
const HEALTH_PATHS = ['/healthz', '/readyz']
const RESET_PATH = '/_control/reset'
const EXPOSED_HEADERS = 'x-amzn-RequestId,x-amzn-ErrorType,x-amz-request-id,x-amz-id-2,x-amzn-ErrorMessage,Date'

type Request = IncomingMessage | Http2ServerRequest
type Response = ServerResponse | Http2ServerResponse

interface Exchange {
  req: Request
  res: ServerResponse
  contentType: string
  requestId: string
  level: LogLevel
  operation?: string
  stream?: string
  errorType?: string
  errorMessage?: string
  error?: unknown
  input?: unknown
  output?: unknown
}

function header(req: Request, name: string) {
  const value = req.headers[name]
  return Array.isArray(value) ? value.join(',') : value ?? ''
}

function sendRaw(exchange: Exchange, body: Buffer | string | null, statusCode = 200) {
  const { req, res } = exchange
  req.removeAllListeners('data')
  res.statusCode = statusCode
  if (typeof body === 'string') exchange.output = body
  if (body === null) return res.end()
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function protocolOf(exchange: Exchange): Protocol {
  return exchange.contentType === AMZ_CBOR ? 'cbor' : 'json'
}

function noteError(exchange: Exchange, data: unknown) {
  const body = ((data as { Output?: unknown } | undefined)?.Output ?? data ?? {}) as Record<string, unknown>
  exchange.errorType = body.__type as string | undefined
  exchange.errorMessage = (body.message ?? body.Message) as string | undefined
}

function sendResponse(exchange: Exchange, data: unknown, statusCode = 200) {
  exchange.output = data
  if (statusCode >= 400) noteError(exchange, data)
  exchange.res.setHeader('Content-Type', exchange.contentType)
  sendRaw(exchange, encodeBody(data, protocolOf(exchange)), statusCode)
}

function sendError(exchange: Exchange, contentValid: boolean, type: string, message: string | number) {
  if (contentValid) return sendResponse(exchange, { __type: type, message }, 400)
  exchange.errorType = type
  if (typeof message === 'number') return sendRaw(exchange, `<${type}/>\n`, message)
  exchange.errorMessage = message
  return sendRaw(exchange, `<${type}>\n  <Message>${message}</Message>\n</${type}>\n`, 403)
}

function sendHealth(store: Store, exchange: Exchange, path: string) {
  const healthy = store.healthy() && (path === '/healthz' || !store.draining)
  exchange.level = 'debug'
  exchange.res.setHeader('Content-Type', 'text/plain')
  sendRaw(exchange, healthy ? 'ok\n' : 'unavailable\n', healthy ? 200 : 503)
}

function sendReset(store: Store, exchange: Exchange, body: Buffer | undefined) {
  let input: unknown = {}
  try {
    if (body) input = JSON.parse(body.toString('utf8'))
  } catch {
    input = undefined
  }
  const stream = (input as { stream?: unknown } | null | undefined)?.stream
  exchange.contentType = 'application/json'
  exchange.input = input
  if (typeof stream === 'string') exchange.stream = stream
  if (typeof input !== 'object' || input === null || Array.isArray(input) || (stream !== undefined && typeof stream !== 'string')) {
    return sendResponse(exchange, { message: 'The body must be empty or a JSON object whose stream member is a string.' }, 400)
  }
  sendResponse(exchange, { streams: store.reset(stream) })
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

function streamOf(data: Record<string, unknown>) {
  if (typeof data.StreamName === 'string') return data.StreamName
  for (const member of ['StreamARN', 'ConsumerARN', 'ResourceARN']) {
    const arn = data[member]
    if (typeof arn !== 'string') continue
    const name = parseConsumerArn(arn)?.streamName ?? streamNameFromArn(arn)
    if (name !== undefined) return name
  }
  return undefined
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
    fail: error => {
      exchange.errorType = error.type
      exchange.errorMessage = error.message
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
  if (req.method !== 'OPTIONS' || !req.headers.origin) res.setHeader('x-amz-id-2', randomBytes(72).toString('base64'))
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'OPTIONS') {
      const requestHeaders = header(req, 'access-control-request-headers')
      const requestMethod = header(req, 'access-control-request-method')
      if (requestHeaders) res.setHeader('Access-Control-Allow-Headers', requestHeaders)
      if (requestMethod) res.setHeader('Access-Control-Allow-Methods', requestMethod)
      res.setHeader('Access-Control-Max-Age', 172800)
      exchange.level = 'debug'
      return sendRaw(exchange, '')
    }
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS)
  }
  const path = req.url?.split('?')[0] ?? ''
  if (req.method === 'GET' && HEALTH_PATHS.includes(path)) return sendHealth(store, exchange, path)
  if (req.method === 'POST' && path === RESET_PATH) return sendReset(store, exchange, body)
  if (req.method !== 'POST') {
    return sendError(exchange, false, 'AccessDeniedException', 'Unable to determine service/operation name to be authorized')
  }
  const contentType = header(req, 'content-type').split(';')[0]!.trim()
  const contentValid = [AMZ_JSON, AMZ_CBOR, 'application/json'].includes(contentType)
  const [service, operation] = header(req, 'x-amz-target').split('.')
  if (operation) exchange.operation = operation
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
  exchange.input = data
  exchange.stream = streamOf(data as Record<string, unknown>)
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
    exchange.error = error
    return sendResponse(exchange, { __type: 'InternalFailure' }, 500)
  }
}

function logRequest(logger: Logger, exchange: Exchange, started: number, body: Buffer | undefined) {
  const { req, res } = exchange
  const status = res.statusCode
  const level = status >= 500 ? 'error' : status >= 400 || exchange.errorType ? 'warn' : exchange.level
  if (!logger.enabled(level)) return
  const trace = logger.enabled('trace')
  logger.log(level, {
    requestId: exchange.requestId,
    method: req.method,
    path: req.url?.split('?')[0],
    operation: exchange.operation,
    stream: exchange.stream,
    status,
    errorType: exchange.errorType,
    errorMessage: exchange.errorMessage,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    aborted: res.writableEnded ? undefined : true,
    error: exchange.error instanceof Error ? exchange.error.stack : exchange.error,
    request: trace ? exchange.input ?? body?.toString('utf8') : undefined,
    response: trace ? exchange.output : undefined,
  })
}

export function createHandler(store: Store, logger: Logger) {
  return (req: Request, res: Response) => {
    const started = performance.now()
    const exchange: Exchange = { req, res: res as ServerResponse, contentType: AMZ_JSON, requestId: randomUUID(), level: 'info' }
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    let body: Buffer | undefined
    exchange.res.setHeader('x-amzn-RequestId', exchange.requestId)
    exchange.res.once('close', () => logRequest(logger, exchange, started, body))
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
      body = size ? Buffer.concat(chunks, size) : undefined
      respond(store, exchange, body)
    })
  }
}
