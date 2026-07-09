/**
 * Receive flow control and protocol-version skew on the worker WebSocket
 * proxy.
 *
 * The flow-control tests validate the credit window end-to-end under the
 * scenario downstream benchmarks worried about (a fast server + a slow
 * consumer): delivery to the consumer thread must hold at `windowFrames`
 * un-acked frames, resume as the consumer reads, and preserve order.
 *
 * The skew tests pin the fail-loudly behaviour when the proxy worker and
 * the client library come from different builds (stale cached chunk):
 * untagged or wrong-version messages must surface `protocol-mismatch`,
 * never silent misbehaviour.
 */
import { MessageChannel as NodeMessageChannel } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"

import {
  attachWebSocketHost,
  type WebSocketLike,
} from "../../src/subduction/worker-websocket/host.js"
import {
  WS_PROXY_CHANNEL,
  WorkerWebSocketError,
  isWsProxyMessage,
  type WorkerPortLike,
} from "../../src/subduction/worker-websocket/protocol.js"
import { WorkerWebSocketTransport } from "../../src/subduction/worker-websocket/transport.js"

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

const openPorts: Array<{ close(): void }> = []
const detachers: Array<() => void> = []

afterEach(() => {
  for (const detach of detachers.splice(0)) detach()
  for (const port of openPorts.splice(0)) port.close()
})

/** A socket the test drives directly: `push()` emits an inbound frame. */
class DrivenSocket implements WebSocketLike {
  binaryType = ""
  closed = false
  #listeners = new Map<string, Array<(event?: unknown) => void>>()

  constructor() {
    queueMicrotask(() => this.#emit("open"))
  }

  push(bytes: Uint8Array) {
    this.#emit("message", { data: bytes.slice().buffer })
  }

  send(_data: Uint8Array) {}

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

const makeHostedChannel = (sockets: DrivenSocket[]) => {
  const channel = new NodeMessageChannel()
  openPorts.push(channel.port1, channel.port2)
  detachers.push(
    attachWebSocketHost(channel.port2 as unknown as WorkerPortLike, {
      createSocket: () => {
        const socket = new DrivenSocket()
        sockets.push(socket)
        return socket
      },
    })
  )
  return channel
}

describe("receive credit window", () => {
  it("holds delivery at windowFrames for a stalled consumer, then drains in order", async () => {
    const sockets: DrivenSocket[] = []
    const channel = makeHostedChannel(sockets)
    const clientPort = channel.port1 as unknown as WorkerPortLike

    // Count every ws-bytes frame that actually crosses the port.
    let delivered = 0
    const counter = (event: MessageEvent) => {
      const msg = event.data
      if (isWsProxyMessage(msg) && (msg as { type: string }).type === "ws-bytes")
        delivered++
    }
    clientPort.addEventListener("message", counter)

    const windowFrames = 4
    const total = 20
    const transport = await WorkerWebSocketTransport.connect(
      clientPort,
      "ws://unused.example",
      { windowFrames }
    )

    // A fast server: 20 frames arrive while the consumer reads nothing.
    for (let i = 0; i < total; i++) sockets[0].push(new Uint8Array([i]))

    // Bounded poll up to the window (cross-port delivery timing is
    // load-sensitive), then two extra ticks for any (incorrect) overshoot.
    const deadline = Date.now() + 2000
    while (delivered < windowFrames && Date.now() < deadline) await tick()
    await tick()
    await tick()

    // Backpressure: only the window's worth crossed; the rest buffer
    // worker-side.
    expect(delivered).toBe(windowFrames)

    // The consumer starts reading: acks refill the window and the backlog
    // drains fully, in order.
    for (let i = 0; i < total; i++) {
      const frame = await transport.recvBytes()
      expect(frame[0]).toBe(i)
    }
    expect(delivered).toBe(total)

    await transport.disconnect()
  })
})

describe("protocol version skew", () => {
  it("host answers an untagged request with a protocol-mismatch error", async () => {
    const sockets: DrivenSocket[] = []
    const channel = makeHostedChannel(sockets)

    const reply = new Promise<{ code?: string; message: string }>(resolve => {
      channel.port1.on("message", (msg: unknown) => {
        if (isWsProxyMessage(msg) && (msg as { type: string }).type === "ws-error")
          resolve(msg as { code?: string; message: string })
      })
    })

    // A pre-versioning (or future) client: channel-tagged but no `v`.
    channel.port1.postMessage({
      channel: WS_PROXY_CHANNEL,
      type: "ws-connect",
      connId: "stale-client",
      url: "ws://unused.example",
    })

    const err = await reply
    expect(err.code).toBe("protocol-mismatch")
    expect(err.message).toMatch(/version mismatch/)
    expect(sockets).toHaveLength(0) // no socket was ever opened
  })

  it("connect() rejects against a stale (untagged) host and closes its socket", async () => {
    const channel = new NodeMessageChannel()
    openPorts.push(channel.port1, channel.port2)

    // An "old build" host: understands the request shape, replies without
    // v — and, crucially, has already opened a real server socket by the
    // time it replies.
    let openedConnId: string | undefined
    const closed = new Promise<string>(resolve => {
      channel.port2.on("message", (msg: { type?: string; connId?: string }) => {
        if (msg?.type === "ws-connect") {
          openedConnId = msg.connId
          channel.port2.postMessage({
            channel: WS_PROXY_CHANNEL,
            type: "ws-open",
            connId: msg.connId,
          })
        }
        // The new client must tell the stale host to close the orphaned
        // socket — old builds understand ws-close.
        if (msg?.type === "ws-close") resolve(msg.connId!)
      })
    })

    await expect(
      WorkerWebSocketTransport.connect(
        channel.port1 as unknown as WorkerPortLike,
        "ws://unused.example",
        { connectTimeoutMs: 1000 }
      )
    ).rejects.toMatchObject({
      name: "WorkerWebSocketError",
      code: "protocol-mismatch",
    })

    // No leaked server connection on the stale host's side.
    await expect(closed).resolves.toBe(openedConnId)
  })

  it("an established transport fails loudly on an untagged frame and closes its socket", async () => {
    const sockets: DrivenSocket[] = []
    const channel = makeHostedChannel(sockets)
    const transport = await WorkerWebSocketTransport.connect(
      channel.port1 as unknown as WorkerPortLike,
      "ws://unused.example"
    )

    const pending = transport.recvBytes()
    // A stale host build pushes an untagged frame (any connId — skew is
    // build-wide, so the transport must not filter it out).
    channel.port2.postMessage({
      channel: WS_PROXY_CHANNEL,
      type: "ws-closed",
      connId: "someone-else",
    })

    await expect(pending).rejects.toMatchObject({
      name: "WorkerWebSocketError",
      code: "protocol-mismatch",
    })
    await expect(transport.closed()).resolves.toBeUndefined()
    const err = (await pending.catch((e: unknown) => e)) as WorkerWebSocketError
    expect(err.message).toMatch(/stale cached worker chunk/)

    // The best-effort ws-close reached the host: no orphaned socket left
    // buffering server pushes with no consumer.
    await tick()
    expect(sockets[0].closed).toBe(true)
  })
})
