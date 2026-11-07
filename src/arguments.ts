const BOOLEAN_FLAGS = new Set(['help', 'ssl'])

export function parseArguments(argv: string[]) {
  const result: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!
    if (!argument.startsWith('--')) continue
    const body = argument.slice(2)
    const equals = body.indexOf('=')
    if (equals >= 0) {
      result[body.slice(0, equals)] = body.slice(equals + 1)
    } else if (body.startsWith('no-')) {
      result[body.slice(3)] = false
    } else {
      const next = argv[i + 1]
      if (!BOOLEAN_FLAGS.has(body) && next !== undefined && !next.startsWith('-')) {
        result[body] = next
        i++
      } else {
        result[body] = true
      }
    }
  }
  return result
}

export function numberOption(value: string | boolean | undefined, fallback: number) {
  const parsed = typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

export function stringOption(value: string | boolean | undefined) {
  return typeof value === 'string' && value !== '' ? value : undefined
}
