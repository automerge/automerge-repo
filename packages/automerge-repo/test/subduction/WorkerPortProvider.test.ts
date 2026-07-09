/**
 * WorkerWebSocketEndpoint with a port *provider*: late-arriving ports,
 * replacement after the port dies (io worker crash), and host teardown on
 * client-port close — all over worker_threads MessageChannels, which fire
 * the same `close` events as browser ports (Chrome ≥132).
 */
import { MessageChannel as NodeMessageChannel } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"

import { WorkerWebSocketEndpoint } from "../../src/subduction/websocket-endpoint.js"
import {
  attachWebSocketHost,
  type WebSocketLike,
} from "../../src/subduction/worker-websocket/host.js"
import type { WorkerPortLike } from "../../src/subduction/worker-websocket/protocol.js"

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

const openPorts: Array<{ close(): void }> = []
const detachers: Array<() => void> = []

afterEach(() => {
  for (const detach of detachers.splice(0)) detach()
  for (const port of openPorts.splice(0)) port.close()
})

/** Echo socket that opens on the next microtask and records close(). */
class FakeSocket implements WebSocketLike {
  binaryType = ""
  closed = false
  #listeners = new Map<string, Array<(event?: unknown) => void>>()

  constructor() {
    queueMicrotask(() => this.#emit("open"))
  }

  send(data: Uint8Array) {
    const buf = data.slice().buffer
    this.#emit("message", { data: buf })
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.#emit("close")
  }

  addEventListener(type: string, listener: (event: never) => void) {
    const list = this.#listeners.get(type) ?? []
    list.push(listener as (event?: unknown) => void)
    this.#listeners.set(type, list)
  }

  #emit(type: string, event?: unknown) {
    for (const l of this.#listeners.get(type) ?? []) l(event as never)
  }
}

/** A "donated port" whose far side runs a live socket host. */
const makeHostedPort = (sockets: FakeSocket[]) => {
  const channel = new NodeMessageChannel()
  openPorts.push(channel.port1, channel.port2)
  const detach = attachWebSocketHost(
    channel.port2 as unknown as WorkerPortLike,
    {
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    }
  )
  detachers.push(detach)
  return channel
}

describe("WorkerWebSocketEndpoint with a port provider", () => {
  it("resolves a late-arriving port on first connect", async () => {
    const sockets: FakeSocket[] = []
    let resolvePort!: (port: WorkerPortLike) => void
    const provided = new Promise<WorkerPortLike>(r => (resolvePort = r))

    const endpoint = new WorkerWebSocketEndpoint("ws://unused.example", {
      worker: () => provided,
    })
    const connecting = endpoint.connect()

    // Donate after connect() is already pending.
    const channel = makeHostedPort(sockets)
    resolvePort(channel.port1 as unknown as WorkerPortLike)

    const transport = await connecting
    await transport.sendBytes(new Uint8Array([1, 2, 3]))
    expect(Array.from(await transport.recvBytes())).toEqual([1, 2, 3])

    await transport.disconnect()
    endpoint.shutdown()
  })

  it("fetches a replacement port after the current one dies", async () => {
    const sockets: FakeSocket[] = []
    const channels: Array<ReturnType<typeof makeHostedPort>> = []
    let fetches = 0
    const endpoint = new WorkerWebSocketEndpoint("ws://unused.example", {
      worker: () => {
        fetches++
        const channel = makeHostedPort(sockets)
        channels.push(channel)
        return channel.port1 as unknown as WorkerPortLike
      },
      connectTimeoutMs: 500,
    })

    const transport = await endpoint.connect()
    expect(fetches).toBe(1)

    // Kill the io side: the host's end closes, our end fires `close`.
    channels[0].port2.close()
    await transport.closed() // transport fails fast, no timeout needed
    await tick()

    // The reconnect loop's next connect() must get a fresh port.
    const transport2 = await endpoint.connect()
    expect(fetches).toBe(2)
    await transport2.sendBytes(new Uint8Array([42]))
    expect(Array.from(await transport2.recvBytes())).toEqual([42])

    await transport2.disconnect()
    endpoint.shutdown()
  })

  it("shares one provider fetch across concurrent connects", async () => {
    const sockets: FakeSocket[] = []
    let fetches = 0
    let resolvePort!: (port: WorkerPortLike) => void
    const provided = new Promise<WorkerPortLike>(r => (resolvePort = r))

    const endpoint = new WorkerWebSocketEndpoint("ws://unused.example", {
      worker: () => {
        fetches++
        return provided
      },
    })

    // Both connects start before any port exists.
    const connecting = [endpoint.connect(), endpoint.connect()]
    resolvePort(
      makeHostedPort(sockets).port1 as unknown as WorkerPortLike
    )

    const [a, b] = await Promise.all(connecting)
    expect(fetches).toBe(1)

    await a.disconnect()
    await b.disconnect()
    endpoint.shutdown()
  })

  it("drops a provider port that times out, so reconnect gets a fresh one", async () => {
    // A port whose far side never answers ws-connect — and whose `close`
    // event never fires (simulating the missed-close race / old browsers).
    const sockets: FakeSocket[] = []
    let fetches = 0
    const endpoint = new WorkerWebSocketEndpoint("ws://unused.example", {
      worker: () => {
        fetches++
        if (fetches === 1) {
          // Dead-but-open port: no host attached, no close event.
          const channel = new NodeMessageChannel()
          openPorts.push(channel.port1, channel.port2)
          return channel.port1 as unknown as WorkerPortLike
        }
        return makeHostedPort(sockets).port1 as unknown as WorkerPortLike
      },
      connectTimeoutMs: 100,
    })

    await expect(endpoint.connect()).rejects.toMatchObject({
      code: "connect-timeout",
    })

    // The timeout must have evicted the cached corpse: the next attempt
    // re-invokes the provider and succeeds on the healthy port.
    const transport = await endpoint.connect()
    expect(fetches).toBe(2)
    await transport.sendBytes(new Uint8Array([5]))
    expect(Array.from(await transport.recvBytes())).toEqual([5])

    await transport.disconnect()
    endpoint.shutdown()
  })

  it("reuses the cached port while it is alive", async () => {
    const sockets: FakeSocket[] = []
    let fetches = 0
    const endpoint = new WorkerWebSocketEndpoint("ws://unused.example", {
      worker: () => {
        fetches++
        return makeHostedPort(sockets).port1 as unknown as WorkerPortLike
      },
    })

    const a = await endpoint.connect()
    const b = await endpoint.connect()
    expect(fetches).toBe(1)

    await a.disconnect()
    await b.disconnect()
    endpoint.shutdown()
  })
})

describe("attachWebSocketHost teardown on port close", () => {
  it("closes owned sockets when the client port closes", async () => {
    const sockets: FakeSocket[] = []
    const channel = makeHostedPort(sockets)

    const endpoint = new WorkerWebSocketEndpoint("ws://unused.example", {
      worker: channel.port1 as unknown as WorkerPortLike,
    })
    const transport = await endpoint.connect()
    expect(sockets).toHaveLength(1)
    expect(sockets[0].closed).toBe(false)

    // The client (repo worker) context dies without a clean disconnect.
    channel.port1.close()
    // The `close` event propagates on its own schedule; poll with a bound
    // rather than a single tick (which can lose a race under CPU load).
    const deadline = Date.now() + 2000
    while (!sockets[0].closed && Date.now() < deadline) await tick()

    // The host must not keep a phantom peer connected.
    expect(sockets[0].closed).toBe(true)

    await transport.closed()
    endpoint.shutdown()
  })
})
