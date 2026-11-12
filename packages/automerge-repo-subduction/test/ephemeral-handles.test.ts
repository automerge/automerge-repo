import * as A from "@automerge/automerge"
// Fullfat initializes the native runtime borrowed by the backend's slim import.
import "@automerge/subduction"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  Presence,
  Repo,
  cbor,
  documentIdToBinary,
  setLoggerFactory,
  type RepoId,
} from "@automerge/automerge-repo"
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge"
import {
  checkHandleExtensions,
  sedimentreeId,
  type SedimentreeEvent,
  type SedimentreeId,
} from "@automerge/automerge-repo/sedimentree"
import {
  SubductionBackend,
  type EphemeralEnvelope,
  type SubductionSession,
} from "../src/index.js"
import { DummySubductionStorageAdapter } from "../src/helpers/DummySubductionStorageAdapter.js"

const { encode, decode } = cbor

// Real history observation, with ephemeral traffic injected and captured.
class ControlledBackend extends SubductionBackend {
  constructor() {
    super({ storage: new DummySubductionStorageAdapter() })
  }
  sessions: {
    inject: (event: SedimentreeEvent) => void
    publish: ReturnType<
      typeof vi.fn<(message: EphemeralEnvelope) => Promise<void>>
    >
  }[] = []

  override open(id: SedimentreeId): SubductionSession {
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
      publishEphemeral: publish,
      markReady: () => session.markReady(),
      close: async () => {
        await session.close()
        await pump
      },
    }
  }
}

function inbound(
  message: unknown,
  envelope: EphemeralEnvelope = {
    messageId: crypto.randomUUID(),
    origin: { kind: "claimed", id: "untrusted", path: [] },
    payload: new Uint8Array(encode(message)),
  }
): SedimentreeEvent {
  return {
    type: "extension",
    kind: "ephemeral",
    sequence: 0,
    payload: {
      message: envelope,
      sender: { kind: "signed", id: "signed-originator", path: ["relay"] },
    },
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

describe("ephemeral handle extension", () => {
  it("owns historical CBOR bytes and allocates fresh IDs", async () => {
    const { backend, repo } = setup()
    const handle = await repo.create({ count: 0 })
    const sub = handle.sub("count")
    const echo = vi.fn()
    handle.on("ephemeral-message", echo)
    const message = { bytes: new Uint8Array([3, 4]) }
    expect(sub.broadcast(message)).toBeUndefined()
    message.bytes.fill(9)
    const sent = backend.sessions[0].publish.mock.calls[0][0]
    expect(decode(sent.payload)).toEqual({ bytes: new Uint8Array([3, 4]) })
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

  it("publishes under a configured Repo id", async () => {
    const backend = new ControlledBackend()
    const repo = new Repo({ backend, id: "tab-1" as RepoId })
    repos.push(repo)
    expect(repo.id).toBe("tab-1")
    const handle = await repo.create({ count: 0 })
    handle.broadcast("hello")
    expect(backend.sessions[0].publish.mock.calls[0][0].origin).toEqual({
      kind: "repo",
      id: "tab-1",
      path: [],
    })
    expect(setup().repo.id).toMatch(/^[0-9a-f-]{36}$/)
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
    backend.sessions[0].inject(
      inbound(null, backend.sessions[0].publish.mock.calls[0][0])
    )
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
        originId: "untrusted",
        message: new Uint8Array([1, 2]),
      })
    }
    expect(removed).not.toHaveBeenCalled()
    expect(backend.sessions[0].publish).toHaveBeenCalledOnce()
  })

  it("passes the check for handle extensions", async () => {
    const { backend } = setup()
    await checkHandleExtensions(backend.handleExtensions)
  })

  it("carries Presence", async () => {
    const { backend, repo } = setup()
    const handle = await repo.create({ count: 0 })
    const presence = new Presence<{ name: string }>({ handle })
    presence.start({ initialState: { name: "local" } })
    try {
      const sent = backend.sessions[0].publish.mock.calls[0][0]
      expect(decode(sent.payload)).toEqual({
        __presence: { type: "snapshot", state: { name: "local" } },
      })
      backend.sessions[0].inject(
        inbound({ __presence: { type: "snapshot", state: { name: "remote" } } })
      )
      await vi.waitFor(() =>
        expect(Object.values(presence.getPeerStates().value)).toEqual([
          expect.objectContaining({
            senderId: "signed-originator",
            originId: "untrusted",
            value: { name: "remote" },
          }),
        ])
      )
    } finally {
      presence.stop()
    }
  })

  it.each(["factory", "error"] as const)(
    "isolates throwing logger %s and failed or invalid ephemerals from history",
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
      backend.sessions[0].inject(
        inbound(null, {
          messageId: "invalid",
          origin: { kind: "claimed", id: "untrusted", path: [] },
          payload: new Uint8Array([0x58]),
        })
      )
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
      expect(throws).toHaveBeenCalledTimes(4)
      await expect(repo.find(handle.url)).resolves.toBe(handle)
      await handle.change(doc => {
        doc.count++
      })
      expect(handle.doc()?.count).toBe(8)
    }
  )
})
