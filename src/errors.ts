export class KinesisError extends Error {
  readonly type: string
  readonly statusCode: number
  readonly messageKey: 'message' | 'Message'
  readonly hasMessage: boolean

  constructor(type: string, message?: string, statusCode = 400, messageKey: 'message' | 'Message' = 'message') {
    super(message ?? type)
    this.type = type
    this.statusCode = statusCode
    this.messageKey = messageKey
    this.hasMessage = message !== undefined
  }

  get body(): Record<string, string> {
    return this.hasMessage ? { __type: this.type, [this.messageKey]: this.message } : { __type: this.type }
  }
}

export function clientError(type: string, message?: string) {
  return new KinesisError(type, message)
}

export function serverError(type = 'InternalFailure', message?: string) {
  return new KinesisError(type, message, 500)
}

export function validationError(message: string) {
  return new KinesisError('ValidationException', message)
}

export function serializationError(message: string) {
  return new KinesisError('SerializationException', message, 400, 'Message')
}

export function invalidArgument(message: string) {
  return new KinesisError('InvalidArgumentException', message)
}

export function resourceNotFound(message: string) {
  return new KinesisError('ResourceNotFoundException', message)
}

export function resourceInUse(message: string) {
  return new KinesisError('ResourceInUseException', message)
}

export function limitExceeded(message: string) {
  return new KinesisError('LimitExceededException', message)
}
