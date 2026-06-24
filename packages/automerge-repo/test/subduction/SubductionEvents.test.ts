/**
 * Public Repo events used to drive a sync indicator:
 *   - "subduction-connection" — aggregate connectedness flips (online/offline),
 *     mirrored by repo.isSubductionConnected().
 *   - "subduction-remote-heads" — a Subduction peer (e.g. the sync server),
 *     keyed by its verifying-key peer id, advertised heads for a document.
 */

import { describe, it, expect, afterEach } from "vitest"
import { WebSocketServer } from "ws"
import {
  Subduction,
  MemorySigner,
  MemoryStorage,
} from "@automerge/automerge-subduction"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { type PeerId } from "../../src/types.js"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import { pause } from "../../src/helpers/pause.js"

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await pause(intervalMs)
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

describe("Subduction Repo events (sync-indicator surface)", () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const c of cleanups.reverse()) await c()
    cleanups.length = 0
  })

  async function startServer() {
    const tmp = new WebSocketServer({ port: 0 })
    await new Promise<void>(r => tmp.on("listening", r))
    const addr = tmp.address()
    if (typeof addr === "string") throw new Error("unexpected address type")
    const port = (addr as { port: number }).port
    await new Promise<void>((r, e) => tmp.close(err => (err ? e(err) : r())))

    const signer = new MemorySigner()
    const subduction = new Subduction({
      signer,
      storage: new MemoryStorage(),
    })
    const wss = new WebSocketServer({ port })
    await new Promise<void>(r => wss.on("listening", r))
    wss.on("connection", ws => {
      subduction
        .acceptTransport(new WebSocketTransport(ws as any), `localhost:${port}`)
        .catch(() => {})
    })
    cleanups.push(async () => {
      await subduction.disconnectAll().catch(() => {})
      await new Promise<void>(r => wss.close(() => r()))
    })
    return { url: `ws://localhost:${port}`, peerId: signer.peerId().toString() }
  }

  it("emits subduction-connection and isSubductionConnected() tracks the server link", async () => {
    const server = await startServer()
    const repo = new Repo({
      peerId: "worker" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      sharePolicy: async () => true,
      subductionWebsocketEndpoints: [server.url],
    })

    expect(repo.isSubductionConnected()).toBe(false)

    const events: boolean[] = []
    repo.on("subduction-connection", ({ connected }) => events.push(connected))

    await waitFor(() => repo.isSubductionConnected(), 6000)
    expect(events.at(-1)).toBe(true)
    expect(events).toContain(true)
  }, 15_000)

  it("connectedSubductionPeerIds() returns the directly-connected sync server", async () => {
    const server = await startServer()
    const repo = new Repo({
      peerId: "worker" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      sharePolicy: async () => true,
      subductionWebsocketEndpoints: [server.url],
    })

    await waitFor(() => repo.isSubductionConnected(), 6000)
    await waitFor(
      async () => (await repo.connectedSubductionPeerIds()).includes(server.peerId),
      6000
    )
    const peers = await repo.connectedSubductionPeerIds()
    expect(peers).toContain(server.peerId)
  }, 15_000)

  it("emits subduction-remote-heads when the server advertises a peer's heads", async () => {
    const server = await startServer()

    const makeWorker = (name: string) =>
      new Repo({
        peerId: name as PeerId,
        storage: new DummyStorageAdapter(),
        network: [],
        sharePolicy: async () => true,
        enableRemoteHeadsGossiping: true,
        subductionWebsocketEndpoints: [server.url],
      })

    const alice = makeWorker("alice")
    const bob = makeWorker("bob")

    const events: Array<{
      documentId: string
      storageId: string
      heads: string[]
    }> = []
    bob.on("subduction-remote-heads", e =>
      events.push({
        documentId: e.documentId,
        storageId: e.storageId,
        heads: [...e.heads],
      })
    )

    await waitFor(
      () => alice.isSubductionConnected() && bob.isSubductionConnected(),
      6000
    )

    const handle = alice.create<{ title: string }>()
    handle.change(d => {
      d.title = "hello"
    })

    // Bob opens the doc; syncing with the server makes the server advertise its
    // heads to Bob, surfacing onRemoteHeads → the event.
    const bobProgress = bob.findWithProgress<{ title: string }>(handle.url)
    await waitFor(() => {
      const s = bobProgress.peek()
      return s.state === "ready" && s.handle.doc()?.title === "hello"
    }, 8000)

    await waitFor(
      () =>
        events.some(
          e => e.documentId === handle.documentId && e.heads.length > 0
        ),
      6000
    )

    const ours = events.find(
      e => e.documentId === handle.documentId && e.heads.length > 0
    )!
    expect(ours.storageId).toBeTruthy() // the server's verifying-key peer id
    expect(ours.heads).toEqual(handle.heads())
  }, 20_000)

  it("the pusher learns the server holds its heads (drives 'synced' on the editing tab)", async () => {
    const server = await startServer()
    const repo = new Repo({
      peerId: "editor" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      sharePolicy: async () => true,
      enableRemoteHeadsGossiping: true,
      subductionWebsocketEndpoints: [server.url],
    })

    const events: Array<{ documentId: string; heads: string[] }> = [];
    repo.on("subduction-remote-heads", e =>
      events.push({ documentId: e.documentId, heads: [...e.heads] })
    )

    await waitFor(() => repo.isSubductionConnected(), 6000)

    const handle = repo.create<{ n: number }>()
    handle.change(d => {
      d.n = 1
    })

    // After we push, the server should advertise our heads back, so the event
    // reports heads equal to our current local heads.
    await waitFor(
      () =>
        events.some(
          e =>
            e.documentId === handle.documentId &&
            sameHeadList(e.heads, handle.heads())
        ),
      8000
    )
    expect(
      events.some(
        e =>
          e.documentId === handle.documentId &&
          sameHeadList(e.heads, handle.heads())
      )
    ).toBe(true)
  }, 20_000)

  it("resyncSubduction is a no-op for a document this repo has not attached", async () => {
    const server = await startServer()
    const a = new Repo({
      peerId: "a" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      sharePolicy: async () => true,
      subductionWebsocketEndpoints: [server.url],
    })
    const b = new Repo({
      peerId: "b" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      sharePolicy: async () => true,
      subductionWebsocketEndpoints: [server.url],
    })

    await waitFor(() => a.isSubductionConnected(), 6000)

    // A well-formed documentId attached on `b` but never on `a`: resyncing it
    // on `a` must hit the unknown-entry early return rather than throw.
    const foreign = b.create<{ n: number }>()
    expect(() => a.resyncSubduction(foreign.documentId)).not.toThrow()
  }, 15_000)

  it("resyncSubduction re-arms a sync round without disrupting a healthy doc", async () => {
    // NB: this harness proactively pushes between connected peers, so a settled
    // reader auto-converges and resync's *unique* recovery effect (re-pulling a
    // diverged-but-settled or heal-exhausted doc) can't be isolated here. We
    // instead guard the always-exercised path: forcing a fresh round on a live
    // "succeeded" entry must not drop the doc or wedge its state machine.
    const server = await startServer()

    const makeWorker = (name: string) =>
      new Repo({
        peerId: name as PeerId,
        storage: new DummyStorageAdapter(),
        network: [],
        sharePolicy: async () => true,
        enableRemoteHeadsGossiping: true,
        subductionWebsocketEndpoints: [server.url],
      })

    const pusher = makeWorker("pusher")
    const reader = makeWorker("reader")

    await waitFor(
      () => pusher.isSubductionConnected() && reader.isSubductionConnected(),
      6000
    )

    const handle = pusher.create<{ n: number }>()
    handle.change(d => {
      d.n = 1
    })

    const readerDoc = reader.findWithProgress<{ n: number }>(handle.url)
    const peekN = (): number | undefined => {
      const s = readerDoc.peek()
      return s.state === "ready" ? s.handle.doc()?.n : undefined
    }
    await waitFor(() => peekN() === 1, 8000)

    // Force a fresh sync round on the already-"succeeded" reader entry. The
    // value must stay put and the link must remain up.
    reader.resyncSubduction(handle.documentId)
    await pause(500)
    expect(peekN()).toBe(1)
    expect(reader.isSubductionConnected()).toBe(true)

    // The entry is still live after the re-arm, so a later change propagates.
    handle.change(d => {
      d.n = 2
    })
    await waitFor(() => peekN() === 2, 8000)
    expect(peekN()).toBe(2)
  }, 30_000)
})

function sameHeadList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")
}
