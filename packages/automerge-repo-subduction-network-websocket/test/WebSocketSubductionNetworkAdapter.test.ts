import "@automerge/subduction"
import { BackendError } from "@automerge/automerge-repo/sedimentree"
import {
  SubductionBackend,
  type SubductionConnect,
  type Transport,
} from "@automerge/automerge-repo-subduction"
import { DummySubductionStorageAdapter } from "@automerge/automerge-repo-subduction/helpers/DummySubductionStorageAdapter.js"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest"
import {
  WebSocketSubductionNetworkAdapter,
  type WebSocketSubductionNetworkAdapterOptions,
} from "../src/index.js"

const { openTransport } = vi.hoisted(() => ({ openTransport: vi.fn() }))
vi.mock("../src/websocket.js", () => ({ openTransport }))

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe("WebSocketSubductionNetworkAdapter", () => {
  let adapters: WebSocketSubductionNetworkAdapter[]
  let transports: Transport[]
  let connect: Mock<SubductionConnect>

  function create(options: WebSocketSubductionNetworkAdapterOptions = {}) {
    const adapter = new WebSocketSubductionNetworkAdapter(
      "ws://localhost:8080",
      options
    )
    adapters.push(adapter)
    return adapter
  }

  function start(options: WebSocketSubductionNetworkAdapterOptions = {}) {
    const adapter = create(options)
    void adapter.start(connect).catch(() => {})
    return adapter
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(1)
    connect = vi.fn<SubductionConnect>().mockResolvedValue("ab".repeat(32))
    adapters = []
    transports = []
    openTransport
      .mockReset()
      .mockImplementation(async (_url, signal, disconnect) => {
        signal.addEventListener("abort", () => disconnect(signal.reason), {
          once: true,
        })
        const transport = {} as Transport
        transports.push(transport)
        return transport
      })
  })

  afterEach(async () => {
    await Promise.all(adapters.map(a => a.stop()))
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("is idle until started, then defaults the service name", async () => {
    const adapter = create()
    expect(adapter.status).toBe("idle")
    expect(openTransport).not.toHaveBeenCalled()
    const states: string[] = []
    const unsubscribe = adapter.subscribe(status => states.push(status))
    await adapter.start(connect)
    expect(adapter.url).toBe("ws://localhost:8080/")
    expect(openTransport).toHaveBeenCalledWith(
      new URL(adapter.url),
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(connect).toHaveBeenCalledWith(transports[0], {
      serviceName: "localhost:8080",
    })
    expect(adapter.status).toBe("connected")
    expect(adapter.error).toBeUndefined()
    unsubscribe()
    await adapter.stop()
    expect(states).toEqual(["idle", "connecting", "connected"])
    await expect(adapter.connected()).rejects.toThrow("closed")
  })

  it("can only be started once", async () => {
    const adapter = create()
    await adapter.start(connect)
    await expect(adapter.start(connect)).rejects.toThrow("already")
  })

  it("uses a service name override", async () => {
    const adapter = new WebSocketSubductionNetworkAdapter({
      url: "wss://proxy.example",
      serviceName: "sync-service",
    })
    adapters.push(adapter)
    await adapter.start(connect)
    expect(connect.mock.calls[0][1]).toEqual({ serviceName: "sync-service" })
  })

  it("rejects start after a failed first attempt but keeps retrying", async () => {
    const failure = new Error("offline")
    openTransport.mockRejectedValueOnce(failure)
    const adapter = create({ retry: { initialMs: 100, maxMs: 200 } })
    await expect(adapter.start(connect)).rejects.toBe(failure)
    await vi.advanceTimersByTimeAsync(100)
    await adapter.connected()
    expect(openTransport).toHaveBeenCalledTimes(2)
  })

  it("retries with exponential backoff, caps it and resets after success", async () => {
    const failure = new Error("offline")
    openTransport
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
    const adapter = start({ retry: { initialMs: 100, maxMs: 200 } })
    const ready = adapter.connected()
    await flush()
    expect(adapter.status).toBe("disconnected")
    expect(adapter.error).toBe(failure)
    await vi.advanceTimersByTimeAsync(99)
    expect(openTransport).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(openTransport).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(openTransport).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(200)
    await ready
    expect(openTransport).toHaveBeenCalledTimes(4)
    openTransport.mock.calls[3][2](new Error("dropped"))
    await vi.advanceTimersByTimeAsync(100)
    expect(openTransport).toHaveBeenCalledTimes(5)
    expect(adapter.status).toBe("connected")
  })

  it("ignores disconnects from an earlier socket", async () => {
    const adapter = start()
    await adapter.connected()
    const staleDisconnect = openTransport.mock.calls[0][2]
    adapter.reconnect()
    await flush()
    expect(adapter.status).toBe("connected")
    expect(openTransport).toHaveBeenCalledTimes(2)
    staleDisconnect(new Error("stale"))
    expect(adapter.status).toBe("connected")
    await vi.advanceTimersByTimeAsync(30_000)
    expect(openTransport).toHaveBeenCalledTimes(2)
  })

  it("ignores reconnect before start", () => {
    const adapter = create()
    adapter.reconnect()
    expect(adapter.status).toBe("idle")
    expect(openTransport).not.toHaveBeenCalled()
  })

  it("allows explicit reconnection with automatic retry disabled", async () => {
    openTransport.mockRejectedValueOnce(new Error("offline"))
    const adapter = start({ retry: false })
    const ready = expect(adapter.connected()).rejects.toThrow("offline")
    await flush()
    await ready
    await vi.advanceTimersByTimeAsync(30_000)
    expect(openTransport).toHaveBeenCalledTimes(1)
    adapter.reconnect()
    await adapter.connected()
    expect(adapter.status).toBe("connected")
  })

  it("stops only its own connection, is idempotent and stops retries", async () => {
    const a = start(),
      b = start()
    await Promise.all([a.connected(), b.connected()])
    const signalA = openTransport.mock.calls[0][1]
    const signalB = openTransport.mock.calls[1][1]
    const stopping = a.stop()
    expect(a.stop()).toBe(stopping)
    await stopping
    expect(signalA.aborted).toBe(true)
    expect(signalB.aborted).toBe(false)
    expect(b.status).toBe("connected")
    a.reconnect()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(openTransport).toHaveBeenCalledTimes(2)
  })

  it("cancels a stalled opening attempt on stop", async () => {
    openTransport.mockImplementationOnce(
      (_url, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason))
        )
    )
    const adapter = create()
    const started = expect(adapter.start(connect)).rejects.toThrow("closed")
    await flush()
    await adapter.stop()
    await started
    expect(adapter.status).toBe("closed")
    expect(connect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("times out a stalled opening and retries", async () => {
    openTransport.mockImplementationOnce(
      (_url, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason))
        )
    )
    const adapter = create({ connectTimeoutMilliseconds: 100 })
    const started = expect(adapter.start(connect)).rejects.toThrow("timed out")
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    await started
    expect(adapter.status).toBe("disconnected")
    await vi.advanceTimersByTimeAsync(500)
    expect(adapter.status).toBe("connected")
  })

  it("closes a transport when backend onboarding fails", async () => {
    connect.mockRejectedValueOnce(new Error("inventory failed"))
    const adapter = start({ retry: false })
    await flush()
    expect(adapter.status).toBe("disconnected")
    expect(openTransport.mock.calls[0][1].aborted).toBe(true)
  })

  it("stops on a closed backend error", async () => {
    connect.mockRejectedValueOnce(
      new BackendError("synchronize", "closed", "closed")
    )
    const adapter = create()
    await expect(adapter.start(connect)).rejects.toThrow("closed")
    expect(adapter.status).toBe("closed")
    await vi.advanceTimersByTimeAsync(30_000)
    expect(openTransport).toHaveBeenCalledOnce()
  })

  it("does not send stale notifications after a subscriber stops the adapter", async () => {
    const adapter = start()
    await adapter.connected()
    const states: string[] = []
    adapter.subscribe(status => {
      if (status === "disconnected") void adapter.stop()
    })
    adapter.subscribe(status => states.push(status))
    openTransport.mock.calls[0][2](new Error("dropped"))
    expect(states).toEqual(["connected", "closed"])
    expect(adapter.status).toBe("closed")
  })

  it("waits for onboarding to settle before stopping", async () => {
    let complete!: (value: string) => void
    connect.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    const adapter = start()
    await flush()
    let stopped = false
    const stopping = adapter.stop().then(() => {
      stopped = true
    })
    await flush()
    expect(stopped).toBe(false)
    complete("ab".repeat(32))
    await stopping
    expect(adapter.status).toBe("closed")
  })

  it("serializes reconnect requests during onboarding", async () => {
    let complete!: (value: string) => void
    connect.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    const adapter = start()
    await flush()
    adapter.reconnect()
    adapter.reconnect()
    expect(openTransport).toHaveBeenCalledOnce()
    complete("ab".repeat(32))
    await flush()
    expect(openTransport).toHaveBeenCalledTimes(2)
    expect(adapter.status).toBe("connected")
  })

  it("validates URLs and retry settings at construction", () => {
    expect(
      () => new WebSocketSubductionNetworkAdapter("https://localhost")
    ).toThrow("ws:")
    expect(() => create({ retry: { initialMs: 0 } })).toThrow("positive")
    expect(() => create({ retry: { initialMs: 100, maxMs: 50 } })).toThrow(
      "maxMs"
    )
  })

  describe("owned by a backend", () => {
    beforeEach(() => {
      vi.spyOn(SubductionBackend.prototype, "addConnection").mockResolvedValue(
        "ab".repeat(32)
      )
    })
    function backend(adapter: WebSocketSubductionNetworkAdapter) {
      return new SubductionBackend({
        storage: new DummySubductionStorageAdapter(),
        network: [adapter],
      })
    }

    it("is started by the backend and stopped by its close", async () => {
      const adapter = create()
      const owner = backend(adapter)
      await adapter.connected()
      await owner.close()
      expect(adapter.status).toBe("closed")
      expect(openTransport.mock.calls[0][1].aborted).toBe(true)
    })

    it("stops retrying immediately when an offline backend closes", async () => {
      openTransport.mockRejectedValue(new Error("offline"))
      const adapter = create()
      const owner = backend(adapter)
      await flush()
      const ready = expect(adapter.connected()).rejects.toThrow("closed")
      await owner.close()
      await ready
      expect(adapter.status).toBe("closed")
      await vi.advanceTimersByTimeAsync(30_000)
      expect(openTransport).toHaveBeenCalledOnce()
    })

    it("keeps backend close idempotent when a closed subscriber re-enters", async () => {
      const adapter = create()
      const owner = backend(adapter)
      await adapter.connected()
      let inner: Promise<void> | undefined
      adapter.subscribe(status => {
        if (status === "closed") inner = owner.close()
      })
      const outer = owner.close()
      await outer
      expect(inner).toBe(outer)
      expect(adapter.status).toBe("closed")
    })
  })
})
