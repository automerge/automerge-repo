export type KeyhiveLogLevel = "silent" | "error" | "warn" | "debug"

const LEVEL_ORDER: Record<KeyhiveLogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  debug: 3,
}

let currentLevel: KeyhiveLogLevel = "warn"

/** Set this package's log level, which defaults to `"warn"`. */
export function setKeyhiveLogLevel(level: KeyhiveLogLevel): void {
  currentLevel = level
}

function enabled(level: KeyhiveLogLevel): boolean {
  return LEVEL_ORDER[currentLevel] >= LEVEL_ORDER[level]
}

export const log = {
  error(...args: unknown[]): void {
    if (enabled("error")) console.error(...args)
  },
  warn(...args: unknown[]): void {
    if (enabled("warn")) console.warn(...args)
  },
  debug(...args: unknown[]): void {
    if (enabled("debug")) console.debug(...args)
  },
}
