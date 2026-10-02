import { next as A } from "@automerge/automerge"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Repo } from "../src/Repo.js"
import { setLoggerFactory } from "../src/Logger.js"
import { documentIdToBinary } from "../src/AutomergeUrl.js"
import { encode, decode } from "../src/helpers/cbor.js"
import { extractRecords } from "../src/sedimentree/automerge/index.js"
import {
  BackendError,
  sedimentreeId,
  type EphemeralEnvelope,
  type SedimentreeEvent,
  type SedimentreeId,
} from "../src/sedimentree/index.js"
import { MemoryBackend } from "../src/sedimentree/testing/MemoryBackend.js"

// Adapted from pinned 5fa3b25f: keep real history observation under injected traffic.
class ControlledBackend extends MemoryBackend {
  sessions: {
    inject: (event: SedimentreeEvent) => void
    publish: ReturnType<
      typeof vi.fn<(message: EphemeralEnvelope) => Promise<void>>
    >
  }[] = []

  override open(id: SedimentreeId) {
    const session = super.open(id)
    const queue: SedimentreeEvent[] = []
    let wake: (() => void) | undefined
    let ended = false
    const inject = (event: SedimentreeEvent) => {
      queue.push(event)
      wake?.()
    }
    const pump = (async () => {
      try {
        for await (const event of session.events) inject(event)
      } finally {
        ended = true
        wake?.()
      }
    })()
    const publish = vi.fn(async (_message: EphemeralEnvelope) => {})
    this.sessions.push({ inject, publish })
    return {
      events: (async function* () {
        while (!ended || queue.length) {
          if (queue.length) yield queue.shift()!
          else
            await new Promise<void>(resolve => {
              wake = resolve
            })
        }
      })(),
      synchronize: session.synchronize.bind(session),
      publishEphemeral: publish,
      close: async () => {
        await session.close()
        await pump
      },
    }
  }
}

function inbound(
  message: unknown
): Extract<SedimentreeEvent, { type: "ephemeral" }> {
  return {
    type: "ephemeral",
    sequence: 0,
    message: {
      messageId: crypto.randomUUID(),
      origin: { kind: "claimed", id: "untrusted", path: [] },
      payload: new Uint8Array(encode(message)),
    },
    sender: { kind: "signed", id: "signed-originator", path: ["relay"] },
  }
}

const repos: Repo[] = []
function setup() {
  const backend = new ControlledBackend()
  const repo = new Repo({ backend })
  repos.push(repo)
  return { backend, repo }
}

afterEach(async () => {
  setLoggerFactory(() => console)
  await Promise.all(repos.splice(0).map(repo => repo.shutdown()))
  vi.restoreAllMocks()
})

describe("DocHandle backend ephemerals", () => {
  it("owns historical CBOR bytes, allocates fresh IDs, preserves subhandle outbound events", async () => {
    const { backend, repo } = setup()
    const handle = await repo.create({ count: 0 })
    const sub = handle.sub("count")
    const outbound = vi.fn(),
      echo = vi.fn()
    sub.on("ephemeral-message-outbound", outbound)
    handle.on("ephemeral-message", echo)
    const message = { bytes: new Uint8Array([3, 4]) }
    expect(sub.broadcast(message)).toBeUndefined()
    message.bytes.fill(9)
    const sent = backend.sessions[0].publish.mock.calls[0][0]
    expect(decode(sent.payload)).toEqual({ bytes: new Uint8Array([3, 4]) })
    expect(outbound).toHaveBeenCalledWith({ handle: sub, data: sent.payload })
    handle.broadcast("next")
    const next = backend.sessions[0].publish.mock.calls[1][0]
    expect(next.messageId).not.toBe(sent.messageId)
    expect(next.origin).toEqual(sent.origin)
    expect(echo).not.toHaveBeenCalled()
    const separate = setup()
    const other = await separate.repo.create({ count: 0 })
    other.broadcast(null)
    expect(
      separate.backend.sessions[0].publish.mock.calls[0][0].origin.id
    ).not.toBe(sent.origin.id)
  })

  it("filters returned own origin and fans authenticated sender out to root/sub/view", async () => {
    const { backend, repo } = setup()
    const handle = await repo.create({ count: 0 })
    const sub = handle.sub("count"),
      view = handle.view(handle.heads())
    const received = vi.fn(),
      scoped = vi.fn(),
      historical = vi.fn(),
      removed = vi.fn()
    handle.on("ephemeral-message", received)
    sub.on("ephemeral-message", scoped)
    view.on("ephemeral-message", historical)
    handle.on("ephemeral-message", removed)
    handle.off("ephemeral-message", removed)
    handle.broadcast("own")
    backend.sessions[0].inject({
      ...inbound(null),
      message: backend.sessions[0].publish.mock.calls[0][0],
    })
    const event = inbound(new Uint8Array([1, 2]))
    backend.sessions[0].inject(event)
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce())
    for (const [listener, target] of [
      [received, handle],
      [scoped, sub],
      [historical, view],
    ] as const) {
      expect(listener).toHaveBeenCalledWith({
        handle: target,
        senderId: "signed-originator",
        message: new Uint8Array([1, 2]),
      })
    }
    event.message.payload.fill(0)
    expect(received.mock.calls[0][0].message).toEqual(new Uint8Array([1, 2]))
    expect(removed).not.toHaveBeenCalled()
    expect(backend.sessions[0].publish).toHaveBeenCalledOnce()
  })

  it.each(["factory", "error"] as const)(
    "isolates throwing logger %s and nonretryable ephemeral errors from history",
    async target => {
      const { backend, repo } = setup()
      const handle = await repo.create({ count: 0 })
      const throws = vi.fn(() => {
        throw new Error("logger failed")
      })
      setLoggerFactory(
        target === "factory" ? throws : () => ({ ...console, error: throws })
      )
      backend.sessions[0].publish.mockRejectedValueOnce(
        new Error("async send failed")
      )
      expect(handle.broadcast("async")).toBeUndefined()
      await vi.waitFor(() => expect(throws).toHaveBeenCalledTimes(1))
      backend.sessions[0].publish.mockImplementationOnce(() => {
        throw new Error("sync send failed")
      })
      expect(handle.broadcast("sync")).toBeUndefined()
      await vi.waitFor(() => expect(throws).toHaveBeenCalledTimes(2))
      handle.on("ephemeral-message", () => {
        throw new Error("listener failed")
      })
      const listener = vi.fn(),
        subListener = vi.fn()
      handle.on("ephemeral-message", listener)
      handle.sub("count").on("ephemeral-message", subListener)
      const invalid = inbound(null)
      backend.sessions[0].inject({
        ...invalid,
        message: { ...invalid.message, payload: new Uint8Array([0x58]) },
      })
      backend.sessions[0].inject({
        type: "failure",
        sequence: 1,
        error: new BackendError("ephemeral", "io", "control failed", false),
      })
      backend.sessions[0].inject(inbound("valid"))
      const remote = A.change(A.clone(handle.fullDoc()), doc => {
        doc.count = 7
      })
      await backend.store(
        sedimentreeId(documentIdToBinary(handle.documentId)!),
        extractRecords(remote)
      )
      await vi.waitFor(() => expect(handle.doc()?.count).toBe(7))
      expect(listener).toHaveBeenCalledOnce()
      expect(subListener).toHaveBeenCalledOnce()
      expect(throws).toHaveBeenCalledTimes(5)
      await expect(repo.find(handle.url)).resolves.toBe(handle)
      await handle.change(doc => {
        doc.count++
      })
      expect(handle.doc()?.count).toBe(8)
    }
  )
})
