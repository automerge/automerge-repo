import { afterEach, describe, expect, it, vi } from "vitest"
import { Repo } from "../src/Repo.js"
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

  it("hands subsystem namespaces to the factory", () => {
    const { factory } = installMockFactory()
    const repo = new Repo()
    // Triggers a warn on the Repo's logger (remote heads gossiping is off by default).
    repo.subscribeToRemotes([])

    const namespaces = factory.mock.calls.map(([ns]) => ns)
    expect(namespaces).toContain("automerge-repo:repo")
  })

  it("routes DocHandle.docSync deprecation through the factory's logger, not console.warn", () => {
    const { loggers } = installMockFactory()
    const consoleWarn = vi.spyOn(console, "warn")

    const repo = new Repo()
    const handle = repo.create<{ x: number }>({ x: 1 })
    handle.docSync()

    const dochandleLogger = loggers.get("automerge-repo:dochandle")
    expect(dochandleLogger).toBeDefined()
    expect(dochandleLogger!.warn).toHaveBeenCalledOnce()
    expect(dochandleLogger!.warn.mock.calls[0][0]).toContain(
      "docSync is deprecated"
    )
    expect(consoleWarn).not.toHaveBeenCalled()
  })
})
