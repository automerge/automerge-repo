import debug from "debug"

/** Minimal logger interface, shaped to match `console`, winston, pino, etc. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Builds a {@link Logger} for the given namespace. */
export type LoggerFactory = (namespace: string) => Logger

// `.debug` is routed through the `debug` package for namespace-based filtering
// via `DEBUG=automerge-repo:*`; the rest go straight to `console`.
const defaultFactory: LoggerFactory = namespace => {
  const trace = debug(namespace)
  const prefix = `[${namespace}]`
  return {
    debug: (message, ...args) => trace(message, ...args),
    info: (message, ...args) => console.info(prefix, message, ...args),
    warn: (message, ...args) => console.warn(prefix, message, ...args),
    error: (message, ...args) => console.error(prefix, message, ...args),
  }
}

let factory: LoggerFactory = defaultFactory

/**
 * Replace the global logger factory. All subsequent {@link makeLogger} calls use it.
 *
 * Call once at startup to route automerge-repo output through your own logger.
 * The factory receives a namespace such as `automerge-repo:repo` or
 * `automerge-repo:docsync:abc12` for each subsystem instance.
 *
 * @example
 * ```ts
 * import { setLoggerFactory } from "@automerge/automerge-repo"
 * import winston from "winston"
 *
 * const logger = winston.createLogger({ ... })
 *
 * setLoggerFactory(namespace => ({
 *   debug: (msg, ...args) => logger.debug(msg, { namespace, args }),
 *   info:  (msg, ...args) => logger.info(msg,  { namespace, args }),
 *   warn:  (msg, ...args) => logger.warn(msg,  { namespace, args }),
 *   error: (msg, ...args) => logger.error(msg, { namespace, args }),
 * }))
 * ```
 */
export function setLoggerFactory(f: LoggerFactory): void {
  factory = f
}

/**
 * Returns a {@link Logger} for `namespace` that delegates to whichever factory
 * is current at the time each method is called. The factory is consulted on
 * every call so that consumers can replace it (via {@link setLoggerFactory})
 * after the library's modules have already been imported.
 */
export function makeLogger(namespace: string): Logger {
  return {
    debug: (message, ...args) => factory(namespace).debug(message, ...args),
    info: (message, ...args) => factory(namespace).info(message, ...args),
    warn: (message, ...args) => factory(namespace).warn(message, ...args),
    error: (message, ...args) => factory(namespace).error(message, ...args),
  }
}
