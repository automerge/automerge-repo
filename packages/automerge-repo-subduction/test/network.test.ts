import * as A from "@automerge/automerge"
// Fullfat initializes the runtime used by the backend's slim import.
import * as N from "@automerge/subduction"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  idBytes,
  sedimentreeId,
  type SedimentreeEvent,
  type SedimentreeId,
  type SedimentreeSession,
} from "@automerge/automerge-repo/sedimentree"
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge"
import { SedimentreeDocumentController } from "../../automerge-repo/src/SedimentreeDocumentController.js"
import { binaryToDocumentId } from "../../automerge-repo/src/AutomergeUrl.js"
import type { BinaryDocumentId } from "../../automerge-repo/src/types.js"
import { SubductionBackend } from "../src/index.js"
import { DiskStore } from "./storage.js"
import { fragmentFixture } from "./fragmentFixture.js"
import { PairedTransport } from "./transport.js"

const tree = sedimentreeId("61".repeat(16))
const otherTree = sedimentreeId("62".repeat(16))
const wait = { timeout: 8000, interval: 20 }
type State = { count: number; left?: number; right?: number }
type Controller = SedimentreeDocumentController<State>
type Peer = {
  backend: SubductionBackend
  storage: DiskStore
  signer: N.MemorySigner
}

function created(count = 0): A.Doc<State> {
  return A.change(A.init<State>({ actor: "aabbcc" }), { time: 0 }, doc => {
    doc.count = count
  })
}
function identity(signer: N.MemorySigner) {
  const peer = signer.peerId()
  try {
    return { kind: "subduction", id: peer.toString(), path: [] }
  } finally {
    peer.free()
  }
}
async function ready(controller: Controller, state: State) {
  await vi.waitFor(() => {
    expect(controller.query.peek().state).toBe("ready")
    expect(controller.handle.doc()).toEqual(state)
  }, wait)
}

describe("paired framed-byte test transport", () => {
  it("copies frames, preserves FIFO, and resumes paused sends", async () => {
    const [a, b] = PairedTransport.pair()
    try {
      const bytes = new Uint8Array([1, 2])
      await a.sendBytes(bytes)
      bytes.fill(9)
      await a.sendBytes(new Uint8Array([3]))
      expect(await b.recvBytes()).toEqual(new Uint8Array([1, 2]))
      expect(await b.recvBytes()).toEqual(new Uint8Array([3]))
      a.pause()
      const receiving = b.recvBytes()
      const sending = a.sendBytes(bytes)
      bytes.fill(4)
      a.resume()
      await sending
      expect(await receiving).toEqual(new Uint8Array([9, 9]))
      a.drop = true
      await a.sendBytes(new Uint8Array([5]))
      a.drop = false
      await a.sendBytes(new Uint8Array([6]))
      expect(await b.recvBytes()).toEqual(new Uint8Array([6]))
    } finally {
      await a.disconnect()
    }
  })

  it("disconnects bilaterally, rejects pending/future work, and fires callbacks once", async () => {
    const [a, b] = PairedTransport.pair()
    const disconnected: string[] = []
    a.onDisconnect(() => disconnected.push("a"))
    b.onDisconnect(() => disconnected.push("b"))
    a.pause()
    b.pause()
    const pending = Promise.allSettled([
      a.recvBytes(),
      b.recvBytes(),
      a.sendBytes(new Uint8Array([1])),
      b.sendBytes(new Uint8Array([2])),
    ])
    await a.disconnect()
    await b.disconnect()
    expect((await pending).map(r => r.status)).toEqual(
      Array(4).fill("rejected")
    )
    expect(disconnected).toEqual(["a", "b"])
    a.onDisconnect(() => disconnected.push("late"))
    expect(disconnected).toEqual(["a", "b", "late"])
    for (const endpoint of [a, b]) {
      await expect(endpoint.recvBytes()).rejects.toThrow("disconnected")
      await expect(endpoint.sendBytes(new Uint8Array())).rejects.toThrow(
        "disconnected"
      )
    }
  })
})

describe("two peers over real authenticated Subduction wire", () => {
  let root: string
  const peers: Peer[] = []
  const controllers: Controller[] = []
  const transports: PairedTransport[] = []
  const sessions: SedimentreeSession[] = []
  const consumers: Promise<void>[] = []

  function peer(storage?: DiskStore): Peer {
    const signer = N.MemorySigner.fromBytes(
      new Uint8Array(32).fill(peers.length + 1)
    )
    const disk = storage ?? new DiskStore(join(root, `peer-${peers.length}`))
    const result = {
      storage: disk,
      signer,
      backend: new SubductionBackend({
        storage: disk,
        signer,
        persistence: "persistent",
        syncTimeoutMilliseconds: 1000,
      }),
    }
    peers.push(result)
    return result
  }
  function controller(
    peer: Peer,
    id = tree,
    initialDoc?: A.Doc<State>
  ): Controller {
    const result = new SedimentreeDocumentController<State>({
      backend: peer.backend,
      id,
      documentId: binaryToDocumentId(idBytes(id) as BinaryDocumentId),
      initialDoc,
    })
    controllers.push(result)
    return result
  }
  function observe(peer: Peer, id: SedimentreeId = tree) {
    const session = peer.backend.open(id)
    sessions.push(session)
    const events: SedimentreeEvent[] = []
    consumers.push(
      (async () => {
        for await (const event of session.events) events.push(event)
      })()
    )
    return { session, events }
  }
  async function connect(a: Peer, b: Peer) {
    const pair = PairedTransport.pair()
    transports.push(...pair)
    const expected = b.signer.peerId()
    const wrappers: N.AuthenticatedTransport[] = []
    try {
      // If either handshake fails, wake the other side rather than leaking it.
      const authenticate = async (
        promise: Promise<N.AuthenticatedTransport>
      ) => {
        try {
          const authenticated = await promise
          wrappers.push(authenticated)
          return authenticated
        } catch (error) {
          await pair[0].disconnect()
          throw error
        }
      }
      const results = await Promise.allSettled([
        authenticate(
          N.AuthenticatedTransport.setup(pair[0], a.signer, expected)
        ),
        authenticate(N.AuthenticatedTransport.accept(pair[1], b.signer)),
      ])
      const [left, right] = results.map(result => {
        if (result.status === "rejected") throw result.reason
        return result.value
      })
      const added = await Promise.allSettled([
        a.backend.addConnection(left),
        b.backend.addConnection(right),
      ])
      for (const result of added) {
        if (result.status === "rejected") throw result.reason
        expect(result.value).toBe(true)
      }
      return pair
    } catch (error) {
      await pair[0].disconnect()
      throw error
    } finally {
      // addConnection clones native connections; neither wrapper owns the signer.
      wrappers.forEach(wrapper => wrapper.free())
      expected.free()
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repo-subduction-network-"))
  })
  afterEach(async () => {
    // Disconnect first even on assertion/handshake failure, waking all native pulls.
    await Promise.allSettled(transports.splice(0).map(t => t.disconnect()))
    await Promise.allSettled(controllers.splice(0).map(c => c.close()))
    await Promise.allSettled(sessions.splice(0).map(s => s.close()))
    await Promise.allSettled(consumers.splice(0))
    await Promise.allSettled(peers.map(p => p.backend.close()))
    peers.splice(0).forEach(p => p.signer.free())
    await rm(root, { recursive: true, force: true })
  }, 20000)

  it("makes an empty receiver ready from the initial commit and reports authenticated peer/heads identities", async () => {
    const a = peer(),
      b = peer()
    const source = controller(a, tree, created())
    await source.flush()
    const observedA = observe(a),
      observedB = observe(b)
    const receiver = controller(b)
    await vi.waitFor(
      () => expect(receiver.query.peek().state).toBe("unavailable"),
      wait
    )
    expect(A.getAllChanges(receiver.document.doc)).toHaveLength(0)
    expect(await b.storage.list("subduction-v1/")).toEqual([])
    const ephemeral = {
      messageId: "test",
      origin: identity(a.signer),
      payload: new Uint8Array([1]),
    }
    await expect(
      observedA.session.publishEphemeral(ephemeral)
    ).resolves.toBeUndefined()
    await connect(a, b)
    await expect(
      observedA.session.publishEphemeral(ephemeral)
    ).rejects.toMatchObject({ code: "unsupported" })
    await ready(receiver, { count: 0 })
    expect(A.getHeads(receiver.document.doc)).toEqual(
      A.getHeads(source.document.doc)
    )

    const [resultA, resultB] = await Promise.all([
      observedA.session.synchronize(),
      observedB.session.synchronize(),
    ])
    expect(resultA).toMatchObject({
      outcome: "complete",
      peers: [{ peer: identity(b.signer), outcome: "complete" }],
      checkpoint: { heads: A.getHeads(source.document.doc) },
    })
    expect(resultB).toMatchObject({
      outcome: "complete",
      peers: [{ peer: identity(a.signer), outcome: "complete" }],
      checkpoint: { heads: A.getHeads(receiver.document.doc) },
    })
    expect(resultA.peers).toHaveLength(1)
    expect(resultB.peers).toHaveLength(1)
    await vi.waitFor(() => {
      expect(observedB.events).toContainEqual(
        expect.objectContaining({
          type: "remote-heads",
          remote: identity(a.signer),
          heads: A.getHeads(source.document.doc),
        })
      )
      expect(observedA.events).toContainEqual(
        expect.objectContaining({
          type: "remote-heads",
          remote: identity(b.signer),
          heads: A.getHeads(receiver.document.doc),
        })
      )
      expect(observedA.events).toContainEqual({
        type: "synchronized",
        result: resultA,
      })
      expect(observedB.events).toContainEqual({
        type: "synchronized",
        result: resultB,
      })
    }, wait)
    // Completion above is a peer exchange, not an acknowledgement of remote disk.
    await receiver.flush()
  }, 20000)

  it("transfers a fragmented 2000-change history and recovers it from the receiver's disk", async () => {
    const a = peer(),
      b = peer()
    const doc = fragmentFixture()
    const source = controller(a, tree, doc)
    await source.flush()
    await connect(a, b)
    const receiver = controller(b)
    await ready(receiver, { count: 1999 })
    await vi.waitFor(async () => {
      expect(A.getAllChanges(receiver.document.doc)).toHaveLength(2000)
      expect(A.getHeads(receiver.document.doc)).toEqual(A.getHeads(doc))
      const keys = await b.storage.list("subduction-v1/")
      expect(keys.some(key => key.includes("/fragments/"))).toBe(true)
      expect(keys.some(key => key.includes("/commits/"))).toBe(true)
    }, wait)
    await receiver.flush()
    await receiver.close()
    await b.backend.close()
    const restarted = controller(peer(b.storage))
    await ready(restarted, { count: 1999 })
    expect(A.getAllChanges(restarted.document.doc)).toHaveLength(2000)
    expect(A.getHeads(restarted.document.doc)).toEqual(A.getHeads(doc))
  }, 20000)

  it("forwards bidirectional handle edits and merges genuinely concurrent changes", async () => {
    const a = peer(),
      b = peer()
    const left = controller(a, tree, created())
    await left.flush()
    const [wireA, wireB] = await connect(a, b)
    const right = controller(b)
    await ready(right, { count: 0 })
    left.handle.change(
      doc => {
        doc.count = 1
      },
      { time: 0 }
    )
    await ready(right, { count: 1 })
    right.handle.change(
      doc => {
        doc.count = 2
      },
      { time: 0 }
    )
    await ready(left, { count: 2 })
    await Promise.all([left.flush(), right.flush()])
    // Both changes use the same causal cut, regardless of native task timing.
    wireA.pause()
    wireB.pause()
    left.handle.change(
      doc => {
        doc.left = 10
      },
      { time: 0 }
    )
    right.handle.change(
      doc => {
        doc.right = 20
      },
      { time: 0 }
    )
    expect(A.getHeads(left.document.doc)).not.toEqual(
      A.getHeads(right.document.doc)
    )
    const mergedHeads = A.getHeads(
      A.merge(A.clone(left.document.doc), A.clone(right.document.doc))
    )
    await Promise.all([left.flush(), right.flush()])
    wireA.resume()
    wireB.resume()
    await ready(left, { count: 2, left: 10, right: 20 })
    await ready(right, { count: 2, left: 10, right: 20 })
    expect(A.getHeads(left.document.doc)).toEqual(mergedHeads)
    expect(A.getHeads(right.document.doc)).toEqual(mergedHeads)
  }, 20000)

  it("automatically forwards local stores without a source session and persists unsolicited writes", async () => {
    const a = peer(),
      b = peer()
    await connect(a, b)
    const doc = created(7)
    // Neither side has opened the document. store/flush only promise local IO.
    await a.backend.store(tree, extractRecords(doc))
    await a.backend.flush()
    await vi.waitFor(async () => {
      expect(
        (await b.storage.list("subduction-v1/")).some(key =>
          key.includes("/commits/")
        )
      ).toBe(true)
    }, wait)
    await b.backend.close()
    const receiver = controller(peer(b.storage))
    await ready(receiver, { count: 7 })
    expect(A.getHeads(receiver.document.doc)).toEqual(A.getHeads(doc))
  }, 20000)

  it("closing a session leaves another watch and another document connected", async () => {
    const a = peer(),
      b = peer()
    const source = controller(a, tree, created())
    const otherSource = controller(a, otherTree, created(100))
    await Promise.all([source.flush(), otherSource.flush()])
    const [wire] = await connect(a, b)
    const closed = controller(b),
      survivor = controller(b)
    const otherReceiver = controller(b, otherTree)
    await Promise.all([
      ready(closed, { count: 0 }),
      ready(survivor, { count: 0 }),
      ready(otherReceiver, { count: 100 }),
    ])
    await closed.close()
    source.handle.change(
      doc => {
        doc.count = 1
      },
      { time: 0 }
    )
    otherSource.handle.change(
      doc => {
        doc.count = 101
      },
      { time: 0 }
    )
    await ready(survivor, { count: 1 })
    await ready(otherReceiver, { count: 101 })
    expect(wire.disconnected).toBe(false)
    expect(closed.document.doc.count).toBe(0)
  }, 20000)

  it("reconnects with a new authenticated wire and replays missed edits and existing session interest", async () => {
    const a = peer(),
      b = peer()
    const source = controller(a, tree, created())
    await source.flush()
    const [oldWire] = await connect(a, b)
    const receiver = controller(b)
    await ready(receiver, { count: 0 })
    await oldWire.disconnect()
    // The absent document's interest exists before reconnection.
    const interested = controller(b, otherTree)
    source.handle.change(
      doc => {
        doc.count = 5
      },
      { time: 0 }
    )
    await source.flush()
    await a.backend.store(otherTree, extractRecords(created(99)))
    await a.backend.flush()
    expect(receiver.document.doc.count).toBe(0)
    const [newWire] = await connect(a, b)
    expect(newWire).not.toBe(oldWire)
    await ready(receiver, { count: 5 })
    await ready(interested, { count: 99 })
    receiver.handle.change(
      doc => {
        doc.count = 6
      },
      { time: 0 }
    )
    await ready(source, { count: 6 })
  }, 20000)
})
