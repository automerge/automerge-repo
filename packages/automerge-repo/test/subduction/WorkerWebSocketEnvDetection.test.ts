/**
 * Deliberately runs under the default happy-dom environment: DOM-emulating
 * test environments may define browser globals (including a fake `Worker`)
 * that cannot actually run our proxy entry module. The endpoint must prefer
 * `node:worker_threads` whenever a real Node runtime is underneath,
 * regardless of what the environment fakes.
 */
import { MessageChannel as NodeMessageChannel } from "node:worker_threads"
import { describe, expect, it, vi } from "vitest"

import {
  WorkerWebSocketEndpoint,
  nodeWorkerThreads,
} from "../../src/subduction/websocket-endpoint.js"
import { attachWebSocketHost } from "../../src/subduction/worker-websocket/host.js"
import type { WorkerPortLike } from "../../src/subduction/worker-websocket/protocol.js"

describe("WorkerWebSocketEndpoint environment detection (happy-dom)", () => {
  it("detects node:worker_threads even inside a DOM-emulating environment", () => {
    // If this returns null while running under Node, the endpoint would
    // fall through to whatever `Worker` global the DOM emulator fakes.
    expect(nodeWorkerThreads()).not.toBeNull()
  })

  it("prefers worker_threads over a fake Worker global in #resolvePort", async () => {
    // Booby-trap the browser path: if the endpoint's branch ordering ever
    // flips to checking `Worker` first, connect() rejects with this marker.
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("fake Worker used")
        }
      }
    )
    try {
      const endpoint = new WorkerWebSocketEndpoint("ws://localhost:1", {
        connectTimeoutMs: 300,
      })
      const err = await endpoint.connect().then(
        () => null,
        e => e as Error
      )
      endpoint.shutdown()

      // The connect must fail (nothing is listening / the spawn can't
      // resolve under the test transform) — but via the Node path, never
      // by constructing the fake browser Worker.
      expect(err).not.toBeNull()
      expect(err!.message).not.toContain("fake Worker used")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("works with an explicit port under a DOM-emulating environment", async () => {
    // The explicit-port path must be environment-agnostic: wire the host
    // in-process over a worker_threads MessageChannel with a fake socket.
    const channel = new NodeMessageChannel()
    const detach = attachWebSocketHost(
      channel.port2 as unknown as WorkerPortLike,
      {
        createSocket: () => {
          const listeners = new Map<string, Array<(event?: unknown) => void>>()
          const socket = {
            binaryType: "",
            send(data: Uint8Array) {
              // Echo straight back.
              const buf = data.slice().buffer
              for (const l of listeners.get("message") ?? []) l({ data: buf })
            },
            close() {
              for (const l of listeners.get("close") ?? []) l()
            },
            addEventListener(type: string, listener: (event?: never) => void) {
              const list = listeners.get(type) ?? []
              list.push(listener as (event?: unknown) => void)
              listeners.set(type, list)
            },
          }
          queueMicrotask(() => {
            for (const l of listeners.get("open") ?? []) l()
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return socket as any
        },
      }
    )

    const endpoint = new WorkerWebSocketEndpoint("ws://unused.example", {
      worker: channel.port1 as unknown as WorkerPortLike,
    })
    const transport = await endpoint.connect()

    await transport.sendBytes(new Uint8Array([9, 8, 7]))
    expect(Array.from(await transport.recvBytes())).toEqual([9, 8, 7])

    await transport.disconnect()
    endpoint.shutdown()
    detach()
    channel.port1.close()
  })
})
