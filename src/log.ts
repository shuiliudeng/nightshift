/** Minimal leveled logger. All output goes to stderr so command results stay on stdout. */

export type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const COLORS: Record<Level, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
}

export class Logger {
  private readonly level: Level
  private readonly scope: string

  constructor(level: Level = 'info', scope = 'nightshift') {
    this.level = level
    this.scope = scope
  }

  child(scope: string): Logger {
    return new Logger(this.level, scope)
  }

  debug(message: string, ...args: unknown[]): void { this.write('debug', message, args) }
  info(message: string, ...args: unknown[]): void { this.write('info', message, args) }
  warn(message: string, ...args: unknown[]): void { this.write('warn', message, args) }
  error(message: string, ...args: unknown[]): void { this.write('error', message, args) }

  private write(level: Level, message: string, args: unknown[]): void {
    if (ORDER[level] < ORDER[this.level]) return
    const time = new Date().toISOString().slice(11, 19)
    const suffix = args.length ? ' ' + args.map(format).join(' ') : ''
    const line = `${time} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${suffix}`
    process.stderr.write(process.stderr.isTTY ? `${COLORS[level]}${line}\u001b[0m\n` : line + '\n')
  }
}

function format(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

export function levelFromEnv(): Level {
  const value = (process.env.NIGHTSHIFT_LOG ?? '').toLowerCase()
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'info'
}
