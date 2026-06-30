import { describe, expect, it } from "vitest"

import type { PeerId } from "@automerge/automerge-repo/slim"

import { WebSocketWorkerClientAdapter } from "../src/WebSocketWorkerClientAdapter.js"
import {
  WS_WORKER_RPC,
  type WsWorkerCommand,
  type WsWorkerEventBody,
} from "../src/websocket-worker-rpc.js"

const peer = (s: string) => s as PeerId

/** Records commands and lets a test drive worker→host events. */
class FakeWsWorker {
  commands: WsWorkerCommand[] = []
  terminated = false
  #listeners: Record<string, Set<(e: unknown) => void>> = {
    message: new Set(),
    error: new Set(),
  }

  addEventListener(type: string, fn: (e: unknown) => void) {
    this.#listeners[type]?.add(fn)
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.#listeners[type]?.delete(fn)
  }
  postMessage(command: WsWorkerCommand) {
    this.commands.push(command)
  }
  terminate() {
    this.terminated = true
  }

  fire(event: WsWorkerEventBody) {
    const data = { channel: WS_WORKER_RPC, ...event }
    for (const fn of this.#listeners.message) fn({ data })
  }
  sends() {
    return this.commands.filter(c => c.type === "send")
  }
}

const make = () => {
  const worker = new FakeWsWorker()
  const adapter = new WebSocketWorkerClientAdapter(
    "wss://x",
    5000,
    worker as unknown as Worker
  )
  return { worker, adapter }
}

const peerMessage = (server: string, client: string) =>
  ({
    type: "peer",
    senderId: peer(server),
    peerMetadata: {},
    selectedProtocolVersion: "1",
    targetId: peer(client),
  }) as const

describe("WebSocketWorkerClientAdapter", () => {
  it("posts a connect command and joins on open", () => {
    const { worker, adapter } = make()
    adapter.connect(peer("client"), {})
    expect(worker.commands[0]).toMatchObject({
      type: "connect",
      url: "wss://x",
      retryInterval: 5000,
    })
    worker.fire({ type: "open" })
    expect(worker.sends()[0]).toMatchObject({
      type: "send",
      message: { type: "join", senderId: "client" },
    })
  })

  it("emits peer-candidate and becomes ready on a peer message", async () => {
    const { worker, adapter } = make()
    const candidates: unknown[] = []
    adapter.on("peer-candidate", p => candidates.push(p))

    adapter.connect(peer("client"), {})
    worker.fire({ type: "open" })
    expect(adapter.isReady()).toBe(false)

    worker.fire({ type: "message", message: peerMessage("server", "client") })
    expect(candidates).toEqual([{ peerId: "server", peerMetadata: {} }])
    expect(adapter.isReady()).toBe(true)
    await expect(adapter.whenReady()).resolves.toBeUndefined()
  })

  it("re-emits inbound data messages", () => {
    const { worker, adapter } = make()
    const messages: unknown[] = []
    adapter.on("message", m => messages.push(m))

    adapter.connect(peer("client"), {})
    const msg = {
      type: "sync",
      senderId: peer("server"),
      targetId: peer("client"),
      data: new Uint8Array([1, 2, 3]),
    }
    worker.fire({ type: "message", message: msg as never })
    expect(messages).toEqual([msg])
  })

  it("forwards send to the worker", () => {
    const { worker, adapter } = make()
    adapter.connect(peer("client"), {})
    adapter.send({
      type: "sync",
      senderId: peer("client"),
      targetId: peer("server"),
      data: new Uint8Array([9]),
    } as never)
    expect(
      worker.sends().some(c => (c.message as { type: string }).type === "sync")
    ).toBe(true)
  })

  it("throws on a zero-length send", () => {
    const { adapter } = make()
    adapter.connect(peer("client"), {})
    expect(() =>
      adapter.send({
        type: "sync",
        senderId: peer("client"),
        targetId: peer("server"),
        data: new Uint8Array([]),
      } as never)
    ).toThrow()
  })

  it("emits peer-disconnected when the socket closes", () => {
    const { worker, adapter } = make()
    const disconnects: unknown[] = []
    adapter.on("peer-disconnected", p => disconnects.push(p))

    adapter.connect(peer("client"), {})
    worker.fire({ type: "message", message: peerMessage("server", "client") })
    worker.fire({ type: "close" })
    expect(disconnects).toEqual([{ peerId: "server" }])
  })

  it("disconnect posts disconnect and terminates the worker", () => {
    const { worker, adapter } = make()
    adapter.connect(peer("client"), {})
    adapter.disconnect()
    expect(worker.commands.some(c => c.type === "disconnect")).toBe(true)
    expect(worker.terminated).toBe(true)
  })

  it("falls back to a main-thread adapter when Worker is unavailable", () => {
    const g = globalThis as { Worker?: unknown }
    const original = g.Worker
    g.Worker = undefined
    try {
      // Large retry interval so the fallback's reconnect timer never fires
      // during the test; we only assert graceful degradation, not connection.
      const adapter = new WebSocketWorkerClientAdapter("wss://x", 60_000)
      expect(() => adapter.connect(peer("client"), {})).not.toThrow()
      expect(adapter.whenReady()).toBeInstanceOf(Promise)
      adapter.disconnect()
    } finally {
      g.Worker = original
    }
  })
})
