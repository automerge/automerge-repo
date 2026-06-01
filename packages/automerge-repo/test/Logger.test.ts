import { afterEach, describe, expect, it, vi } from "vitest"
import {
  makeLogger,
  Logger,
  LoggerFactory,
  setLoggerFactory,
} from "../src/Logger.js"

type MockLogger = Logger & {
  debug: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

const mockLogger = (): MockLogger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
})

const installMockFactory = (): {
  factory: ReturnType<typeof vi.fn>
  loggers: Map<string, MockLogger>
} => {
  const loggers = new Map<string, MockLogger>()
  const factory = vi.fn<LoggerFactory>((namespace: string) => {
    let logger = loggers.get(namespace)
    if (!logger) {
      logger = mockLogger()
      loggers.set(namespace, logger)
    }
    return logger
  })
  setLoggerFactory(factory)
  return { factory, loggers }
}

describe("Logger", () => {
  // Each test calls installMockFactory(), which replaces the global factory.
  // Vitest isolates test files so this doesn't leak into other suites.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("delegates makeLogger to the current factory", () => {
    const { factory, loggers } = installMockFactory()
    const log = makeLogger("test:ns")
    log.warn("hello")

    expect(factory).toHaveBeenCalledWith("test:ns")
    expect(loggers.get("test:ns")?.warn).toHaveBeenCalledWith("hello")
  })

  it("resolves the factory on each call, so a logger built before setLoggerFactory still uses it", () => {
    // A caller (like a subsystem) that captures its logger up front, before
    // any custom factory is installed.
    const log = makeLogger("test:ns")

    const { loggers } = installMockFactory()
    log.warn("after swap")

    expect(loggers.get("test:ns")?.warn).toHaveBeenCalledWith("after swap")
  })
})
