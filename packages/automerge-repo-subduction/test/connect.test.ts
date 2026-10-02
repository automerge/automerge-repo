import { MemorySigner } from "@automerge/subduction"
import { BackendError } from "@automerge/automerge-repo/sedimentree"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  connectSubductionServer,
  MemoryByteStore,
  SubductionBackend,
  type AuthenticatedTransport,
  type SubductionConnection,
} from "../src/index.js"

const { openTransport } = vi.hoisted(() => ({ openTransport: vi.fn() }))
vi.mock("../src/websocket.js", () => ({ openTransport }))

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe("managed server connections", () => {
  let signer: MemorySigner
  let backend: SubductionBackend
  let connections: SubductionConnection[]
  let transports: { free: ReturnType<typeof vi.fn> }[]

  function connect(options = {}) {
    const connection = connectSubductionServer(
      backend,
      signer,
      "ws://localhost:8080",
      options
    )
    connections.push(connection)
    return connection
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(1)
    signer = MemorySigner.generate()
    backend = new SubductionBackend({ signer, storage: new MemoryByteStore() })
    vi.spyOn(backend, "addConnection").mockResolvedValue(true)
    connections = []
    transports = []
    openTransport
      .mockReset()
      .mockImplementation(
        async (_url, _signer, _service, signal, disconnect) => {
          signal.addEventListener("abort", () => disconnect(signal.reason), {
            once: true,
          })
          const transport = { free: vi.fn() }
          transports.push(transport)
          return transport as unknown as AuthenticatedTransport
        }
      )
  })

  afterEach(async () => {
    await Promise.all(connections.map(c => c.close()))
    await backend.close()
    signer.free()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("starts immediately, shares the signer, defaults the service name and releases wrappers", async () => {
    const connection = connect()
    const states: string[] = []
    const unsubscribe = connection.subscribe(status => states.push(status))
    await connection.connected()
    expect(connection.url).toBe("ws://localhost:8080/")
    expect(openTransport).toHaveBeenCalledWith(
      new URL(connection.url),
      signer,
      "localhost:8080",
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(backend.addConnection).toHaveBeenCalledWith(transports[0])
    expect(transports[0].free).toHaveBeenCalledOnce()
    expect(connection.status).toBe("connected")
    expect(connection.error).toBeUndefined()
    unsubscribe()
    await connection.close()
    expect(states.at(-1)).toBe("connected")
    await expect(connection.connected()).rejects.toThrow("closed")
  })

  it("uses a service name override", async () => {
    const connection = connectSubductionServer(backend, signer, {
      url: "wss://proxy.example",
      serviceName: "sync-service",
    })
    connections.push(connection)
    await connection.connected()
    expect(openTransport.mock.calls[0][2]).toBe("sync-service")
  })

  it("retries with exponential backoff, caps it and resets after success", async () => {
    const failure = new Error("offline")
    openTransport
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
    const connection = connect({ retry: { initialMs: 100, maxMs: 200 } })
    const ready = connection.connected()
    await flush()
    expect(connection.status).toBe("disconnected")
    expect(connection.error).toBe(failure)
    await vi.advanceTimersByTimeAsync(99)
    expect(openTransport).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(openTransport).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(openTransport).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(200)
    await ready
    expect(openTransport).toHaveBeenCalledTimes(4)
    openTransport.mock.calls[3][4](new Error("dropped"))
    await vi.advanceTimersByTimeAsync(100)
    expect(openTransport).toHaveBeenCalledTimes(5)
    expect(connection.status).toBe("connected")
  })

  it("ignores disconnects from an earlier socket", async () => {
    const connection = connect()
    await connection.connected()
    const staleDisconnect = openTransport.mock.calls[0][4]
    connection.reconnect()
    await flush()
    expect(connection.status).toBe("connected")
    expect(openTransport).toHaveBeenCalledTimes(2)
    staleDisconnect(new Error("stale"))
    expect(connection.status).toBe("connected")
    await vi.advanceTimersByTimeAsync(30_000)
    expect(openTransport).toHaveBeenCalledTimes(2)
  })

  it("allows explicit reconnection with automatic retry disabled", async () => {
    openTransport.mockRejectedValueOnce(new Error("offline"))
    const connection = connect({ retry: false })
    const ready = expect(connection.connected()).rejects.toThrow("offline")
    await flush()
    await ready
    await vi.advanceTimersByTimeAsync(30_000)
    expect(openTransport).toHaveBeenCalledTimes(1)
    connection.reconnect()
    await connection.connected()
    expect(connection.status).toBe("connected")
  })

  it("closes only its own connection, is idempotent and stops retries", async () => {
    const a = connect(),
      b = connect()
    await Promise.all([a.connected(), b.connected()])
    const signalA = openTransport.mock.calls[0][3]
    const signalB = openTransport.mock.calls[1][3]
    const closing = a.close()
    expect(a.close()).toBe(closing)
    await closing
    expect(signalA.aborted).toBe(true)
    expect(signalB.aborted).toBe(false)
    expect(b.status).toBe("connected")
    a.reconnect()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(openTransport).toHaveBeenCalledTimes(2)
  })

  it("cancels a stalled opening attempt on close", async () => {
    openTransport.mockImplementationOnce(
      (_url, _signer, _service, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason))
        )
    )
    const connection = connect()
    const ready = expect(connection.connected()).rejects.toThrow("closed")
    await flush()
    await connection.close()
    await ready
    expect(connection.status).toBe("closed")
    expect(backend.addConnection).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("times out a stalled opening and retries", async () => {
    openTransport.mockImplementationOnce(
      (_url, _signer, _service, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason))
        )
    )
    const connection = connect({ connectTimeoutMilliseconds: 100 })
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    expect(connection.status).toBe("disconnected")
    expect(String(connection.error)).toContain("timed out")
    await vi.advanceTimersByTimeAsync(500)
    expect(connection.status).toBe("connected")
  })

  it("frees and closes a transport when backend onboarding fails", async () => {
    vi.mocked(backend.addConnection).mockRejectedValueOnce(
      new Error("inventory failed")
    )
    const connection = connect({ retry: false })
    await flush()
    expect(connection.status).toBe("disconnected")
    expect(transports[0].free).toHaveBeenCalledOnce()
    expect(openTransport.mock.calls[0][3].aborted).toBe(true)
  })

  it("stops on a closed backend error", async () => {
    vi.mocked(backend.addConnection).mockRejectedValueOnce(
      new BackendError("synchronize", "closed", "closed")
    )
    const connection = connect()
    const ready = expect(connection.connected()).rejects.toThrow("closed")
    await flush()
    await ready
    expect(connection.status).toBe("closed")
    await vi.advanceTimersByTimeAsync(30_000)
    expect(openTransport).toHaveBeenCalledOnce()
  })

  it("stops retrying immediately when an offline backend closes", async () => {
    openTransport.mockRejectedValue(new Error("offline"))
    const connection = connect()
    await flush()
    const ready = expect(connection.connected()).rejects.toThrow("closed")
    await backend.close()
    await ready
    expect(connection.status).toBe("closed")
    await vi.advanceTimersByTimeAsync(30_000)
    expect(openTransport).toHaveBeenCalledOnce()
  })

  it("does not open a socket for an already closed backend", async () => {
    await backend.close()
    const connection = connect()
    await flush()
    expect(connection.status).toBe("closed")
    expect(openTransport).not.toHaveBeenCalled()
  })

  it("keeps backend close idempotent when a closed subscriber re-enters", async () => {
    const connection = connect()
    await connection.connected()
    let inner: Promise<void> | undefined
    connection.subscribe(status => {
      if (status === "closed") inner = backend.close()
    })
    const outer = backend.close()
    expect(inner).toBe(outer)
    await outer
    expect(connection.status).toBe("closed")
  })

  it("does not send stale notifications after a subscriber closes the connection", async () => {
    const connection = connect()
    await connection.connected()
    const states: string[] = []
    connection.subscribe(status => {
      if (status === "disconnected") void connection.close()
    })
    connection.subscribe(status => states.push(status))
    openTransport.mock.calls[0][4](new Error("dropped"))
    expect(states).toEqual(["connected", "closed"])
    expect(connection.status).toBe("closed")
  })

  it("waits for onboarding to settle before freeing a cancelled transport", async () => {
    let complete!: (value: boolean) => void
    vi.mocked(backend.addConnection).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    const connection = connect()
    await flush()
    const closing = connection.close()
    expect(transports[0].free).not.toHaveBeenCalled()
    complete(true)
    await closing
    expect(transports[0].free).toHaveBeenCalledOnce()
    expect(connection.status).toBe("closed")
  })

  it("serializes reconnect requests during onboarding", async () => {
    let complete!: (value: boolean) => void
    vi.mocked(backend.addConnection).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    const connection = connect()
    await flush()
    connection.reconnect()
    connection.reconnect()
    expect(openTransport).toHaveBeenCalledOnce()
    complete(true)
    await flush()
    expect(openTransport).toHaveBeenCalledTimes(2)
    expect(connection.status).toBe("connected")
  })

  it("validates URLs and retry settings before opening sockets", () => {
    expect(() =>
      connectSubductionServer(backend, signer, "https://localhost")
    ).toThrow("ws:")
    expect(() => connect({ retry: { initialMs: 0 } })).toThrow("positive")
    expect(() => connect({ retry: { initialMs: 100, maxMs: 50 } })).toThrow(
      "maxMs"
    )
    expect(openTransport).not.toHaveBeenCalled()
  })
})
