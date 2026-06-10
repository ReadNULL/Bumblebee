export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value
  }
  return 'info'
}

export class BumblebeeLogger {
  constructor(
    private readonly scope = 'bumblebee',
    private readonly level: LogLevel = parseLogLevel(process.env.BUMBLEBEE_LOG_LEVEL),
  ) {}

  child(scope: string): BumblebeeLogger {
    return new BumblebeeLogger(`${this.scope}:${scope}`, this.level)
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args)
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args)
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args)
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args)
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return
    const prefix = `[${this.scope}] ${message}`
    if (level === 'debug') console.debug(prefix, ...args)
    else if (level === 'info') console.info(prefix, ...args)
    else if (level === 'warn') console.warn(prefix, ...args)
    else console.error(prefix, ...args)
  }
}

export function createLogger(scope?: string): BumblebeeLogger {
  return new BumblebeeLogger(scope)
}
