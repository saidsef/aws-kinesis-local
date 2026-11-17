export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const

export type LogLevel = typeof LOG_LEVELS[number]

export function isLogLevel(value: unknown): value is LogLevel {
  return LOG_LEVELS.includes(value as LogLevel)
}

function replacer(this: Record<string, unknown>, key: string, value: unknown) {
  const raw = this[key]
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64')
  return typeof value === 'bigint' ? value.toString() : value
}

export class Logger {
  readonly level: LogLevel
  private readonly write: (line: string) => void

  constructor(level: LogLevel, write: (line: string) => void = line => process.stdout.write(line)) {
    if (!isLogLevel(level)) throw new Error(`Unknown log level ${level}. Use ${LOG_LEVELS.join(', ')}.`)
    this.level = level
    this.write = write
  }

  enabled(level: LogLevel) {
    return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(this.level)
  }

  log(level: LogLevel, fields: Record<string, unknown>) {
    if (this.enabled(level)) this.write(`${JSON.stringify({ time: new Date().toISOString(), level, ...fields }, replacer)}\n`)
  }
}
