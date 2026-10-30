import { next as A } from "@automerge/automerge"
import { next as SlimA } from "@automerge/automerge/slim"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Repo } from "../src/Repo.js"
import type { DocHandle } from "../src/DocHandle.js"
import {
  binaryToDocumentId,
  encodeHeads,
  generateAutomergeUrl,
  parseAutomergeUrl,
} from "../src/AutomergeUrl.js"
import { encode } from "../src/helpers/cbor.js"
import { Presence } from "../src/presence/Presence.js"
import { PRESENCE_MESSAGE_MARKER } from "../src/presence/constants.js"
import type { BinaryDocumentId, PeerId } from "../src/types.js"
import { MemoryBackend } from "./helpers/MemoryBackend.js"
import { BackendError, commitId } from "../src/sedimentree/index.js"
import { recordKey } from "./helpers/records.js"
import {
  extractNewCommits,
  extractRecords,
} from "../src/sedimentree/automerge/index.js"
import {
  noPeers,
  scriptedBackend,
  type ScriptedSession,
} from "./helpers/scriptedBackend.js"

// Native ESM exports are sealed; forward through a configurable namespace for spies.
vi.mock("@automerge/automerge/slim", async importOriginal => {
  const actual =
    await importOriginal<typeof import("@automerge/automerge/slim")>()
  return { ...actual, next: { ...actual.next } }
})

type Doc = { count: number; nested?: { value: number } }

const heads = (doc: A.Doc<unknown>) => A.getHeads(doc).map(commitId)

const remoteHeads = (peer: string, heads: ReturnType<typeof commitId>[]) => ({
  type: "remote-heads" as const,
  sequence: 1,
  remote: { kind: "test", id: peer, path: [] },
  heads,
})

describe("Repo loading", () => {
  const repos: Repo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map(r => r.shutdown()))
    vi.restoreAllMocks()
  })

  /** A lookup of a document the backend has not yet delivered anything for. */
  async function lookup() {
    const scripted = scriptedBackend()
    const r = new Repo({ backend: scripted.backend })
    repos.push(r)
    const id = parseAutomergeUrl(generateAutomergeUrl()).documentId
    const progress = r.query<Doc>(id)
    const handle = r.handles[id] as DocHandle<Doc>
    const session = await scripted.session()
    return { r, id, handle, progress, session, scripted }
  }

  /** A locally created document, ready from the start. */
  async function created(doc: A.Doc<Doc> = A.from({ count: 0 })) {
    const scripted = scriptedBackend()
    const r = new Repo({ backend: scripted.backend })
    repos.push(r)
    const handle = await r.import<Doc>(A.save(doc))
    const session = await scripted.session()
    return { r, handle, session, scripted }
  }

  /** One storage scan: each blob in its own event, then the scan's completion. */
  async function scan(session: ScriptedSession, blobs: Uint8Array[]) {
    for (const blob of blobs)
      await session.push({ type: "blobs", sequence: 1, blobs: [blob] })
    await session.push({
      type: "local-load-complete",
      found: blobs.length > 0,
      backendSyncs: true,
    })
  }

  describe("initial blobs", () => {
    it("loads first storage blobs without creating an empty document", async () => {
      const { handle, session } = await lookup()
      const load = vi.spyOn(SlimA, "load")
      const incremental = vi.spyOn(SlimA, "loadIncremental")
      await scan(session, A.getAllChanges(A.from({ count: 1 })))
      expect(load).toHaveBeenCalledOnce()
      expect(incremental).not.toHaveBeenCalled()
      expect(load.mock.calls[0][1]).toEqual({ allowMissingChanges: true })
      expect(handle.doc()).toEqual({ count: 1 })
      await scan(session, A.getAllChanges(A.from({ nested: { value: 2 } })))
      expect(load).toHaveBeenCalledOnce()
      expect(incremental).toHaveBeenCalledOnce()
      expect(handle.doc()).toEqual({ count: 1, nested: { value: 2 } })
    })

    it("fails the lookup when the first load fails", async () => {
      const { handle, session, progress } = await lookup()
      vi.spyOn(SlimA, "load").mockImplementationOnce(() => {
        throw new Error("invalid bytes")
      })
      const incremental = vi.spyOn(SlimA, "loadIncremental")
      await scan(session, A.getAllChanges(A.from({ count: 1 })))
      expect(incremental).not.toHaveBeenCalled()
      expect(handle.heads()).toEqual([])
      await vi.waitFor(() =>
        expect(progress.state()).toMatchObject({
          status: "failed",
          error: { message: "invalid bytes" },
        })
      )
    })

    it("retains missing dependencies from an incomplete first storage batch", async () => {
      const first = A.from({ count: 1 })
      const second = A.change(first, doc => {
        doc.count = 2
      })
      const { handle, session } = await lookup()
      await scan(session, A.getChanges(first, second))
      expect(handle.doc()?.count).toBeUndefined()
      await session.push({
        type: "records",
        phase: "live",
        sequence: 2,
        records: extractRecords(first),
      })
      expect(handle.doc()).toEqual({ count: 2 })
    })

    it("throws on edits before readiness without materializing an empty doc", async () => {
      const { handle, session } = await lookup()
      expect(() =>
        handle.change(doc => {
          doc.count = 1
        })
      ).toThrow("Document is not ready")
      const load = vi.spyOn(SlimA, "load")
      await scan(session, A.getAllChanges(A.from({ nested: { value: 2 } })))
      expect(load).toHaveBeenCalledOnce()
      expect(handle.doc()).toEqual({ nested: { value: 2 } })
    })

    it("does not replace pending peer history with the first storage batch", async () => {
      const remote = A.from({ count: 1 })
      const newer = A.change(remote, doc => {
        doc.count = 2
      })
      const laterHead = A.getHeads(newer)[0]
      const { handle, session } = await lookup()
      await session.push({
        type: "records",
        phase: "live",
        sequence: 1,
        records: extractRecords(newer).filter(
          r => r.kind === "commit" && r.id === laterHead
        ),
      })
      expect(handle.heads()).toEqual([])
      const load = vi.spyOn(SlimA, "load")
      await scan(session, A.getAllChanges(remote))
      expect(load).not.toHaveBeenCalled()
      expect(handle.doc()).toEqual({ count: 2 })
    })

    it("keeps a pre-load snapshot observed by a caller", async () => {
      const { handle, session } = await lookup()
      const before = handle.fullDoc()
      const actor = A.getActorId(before)
      const load = vi.spyOn(SlimA, "load")
      const incremental = vi.spyOn(SlimA, "loadIncremental")
      await scan(session, A.getAllChanges(A.from({ count: 1 })))
      expect(load).not.toHaveBeenCalled()
      expect(incremental).toHaveBeenCalledOnce()
      expect(A.getActorId(handle.fullDoc())).toBe(actor)
      expect(handle.doc()).toEqual({ count: 1 })
    })

    it("applies one initial blob without retaining its input bytes", async () => {
      const blob = A.getAllChanges(A.from({ count: 1 }))[0]
      const { handle, session } = await lookup()
      await scan(session, [blob])
      expect(handle.doc()).toEqual({ count: 1 })
      blob.fill(0)
      expect(handle.doc()).toEqual({ count: 1 })
    })

    it("buffers a scan's blobs and applies them in one load on completion", async () => {
      const source = A.change(A.from({ count: 1 }), doc => {
        doc.count = 2
      })
      const blobs = A.getAllChanges(source)
      expect(blobs.length).toBeGreaterThan(1)
      const { handle, session, progress } = await lookup()
      const load = vi.spyOn(SlimA, "load")
      const changed = vi.fn()
      handle.on("change", changed)
      for (const blob of blobs)
        await session.push({ type: "blobs", sequence: 1, blobs: [blob] })
      expect(load).not.toHaveBeenCalled()
      expect(handle.heads()).toEqual([])
      expect(changed).not.toHaveBeenCalled()
      expect(progress.state().status).toBe("loading")
      await session.push({ type: "local-load-complete", found: true })
      expect(load).toHaveBeenCalledOnce()
      expect(handle.doc()).toEqual({ count: 2 })
      expect(changed).toHaveBeenCalledOnce()
      expect(progress.state().status).toBe("ready")
      expect(session.synchronize).not.toHaveBeenCalled()
      expect(session.markComplete).toHaveBeenCalledOnce()
    })

    it("delivers initial change patches to root and scoped listeners", async () => {
      const source = A.from({ count: 1, nested: { value: 2 } })
      const { handle, session } = await lookup()
      const root = vi.fn()
      const scoped = vi.fn()
      handle.on("change", root)
      handle.sub("nested").on("change", scoped)
      await scan(session, A.getAllChanges(source))
      expect(root).toHaveBeenCalledOnce()
      expect(root.mock.calls[0][0].patches.length).toBeGreaterThan(0)
      expect(scoped).toHaveBeenCalledOnce()
      expect(scoped.mock.calls[0][0].doc).toEqual({ value: 2 })
    })

    it("delivers initial change to a listener attached during heads-changed", async () => {
      const { handle, session } = await lookup()
      const changed = vi.fn()
      handle.once("heads-changed", () => handle.on("change", changed))
      await scan(session, A.getAllChanges(A.from({ count: 1 })))
      expect(changed).toHaveBeenCalledOnce()
      expect(changed.mock.calls[0][0].doc).toEqual({ count: 1 })
    })

    it("does not compute an initial change with no change listeners", async () => {
      const { handle, session } = await lookup()
      const diff = vi.spyOn(SlimA, "diff")
      const headsChanged = vi.fn()
      handle.on("heads-changed", headsChanged)
      await scan(session, A.getAllChanges(A.from({ count: 1 })))
      expect(handle.doc()).toEqual({ count: 1 })
      expect(headsChanged).toHaveBeenCalledOnce()
      expect(diff).not.toHaveBeenCalled()
    })

    it("only treats the first incoming update as initial", async () => {
      const first = A.from({ count: 1 })
      const firstRecords = extractRecords(first)
      const second = A.change(first, doc => {
        doc.count = 2
      })
      const { handle, session } = await lookup()
      const headsChanged = vi.fn()
      handle.on("heads-changed", headsChanged)
      await session.push({
        type: "records",
        phase: "live",
        sequence: 1,
        records: firstRecords,
      })
      expect(headsChanged).toHaveBeenCalledOnce()
      const changed = vi.fn()
      handle.on("change", changed)
      await session.push({
        type: "records",
        phase: "live",
        sequence: 2,
        records: extractRecords(second),
      })
      expect(headsChanged).toHaveBeenCalledTimes(2)
      expect(handle.doc()).toEqual({ count: 2 })
      expect(changed).toHaveBeenCalledOnce()
      expect(changed.mock.calls[0][0].doc).toEqual({ count: 2 })
    })

    it("still delivers the first local edit as a change", async () => {
      const { handle } = await created()
      const changed = vi.fn()
      handle.on("change", changed)
      await handle.change(doc => {
        doc.count = 1
      })
      expect(changed).toHaveBeenCalledOnce()
    })
  })

  describe("readiness", () => {
    it("asks for synchronization after an empty local load unless the backend syncs", async () => {
      const { session, progress } = await lookup()
      await session.push({ type: "local-load-complete", found: false })
      expect(progress.state().status).toBe("loading")
      expect(session.synchronize).toHaveBeenCalledOnce()
      const other = await lookup()
      await other.session.push({
        type: "local-load-complete",
        found: false,
        backendSyncs: true,
      })
      expect(other.session.synchronize).not.toHaveBeenCalled()
    })

    it("tells the session once Repo has a verified snapshot, and immediately for created documents", async () => {
      const { session } = await created()
      expect(session.markComplete).toHaveBeenCalledOnce()
      const remote = A.from({ count: 3 })
      const empty = await lookup()
      await empty.session.push({
        type: "local-load-complete",
        found: false,
        marker: { sequence: 0, heads: [] },
      })
      expect(empty.session.markComplete).not.toHaveBeenCalled()
      await empty.session.push({
        type: "records",
        phase: "live",
        sequence: 1,
        records: extractRecords(remote),
      })
      await empty.session.push({
        type: "history-marker",
        marker: { sequence: 1, heads: heads(remote) },
      })
      expect(empty.progress.state().status).toBe("ready")
      expect(empty.session.markComplete).toHaveBeenCalledOnce()
    })

    it("gates a nonempty prefix on a complete history marker", async () => {
      let remote = A.from({ count: 1 })
      const first = extractRecords(remote)
      remote = A.change(remote, d => {
        d.count = 2
      })
      const { session, progress } = await lookup()
      await session.push({
        type: "records",
        records: first,
        phase: "initial",
        sequence: 1,
      })
      expect(progress.state().status).toBe("loading")
      await session.push({
        type: "local-load-complete",
        found: true,
        marker: { sequence: 1, heads: heads(remote) },
      })
      expect(progress.state().status).toBe("loading")
      await session.push({
        type: "records",
        records: extractRecords(remote),
        phase: "initial",
        sequence: 1,
      })
      expect(progress.state().status).toBe("ready")
    })

    it("settles an empty local cut with no peers, without permanently failing", async () => {
      const { session, progress, r, id } = await lookup()
      const unavailable = vi.fn()
      r.on("unavailable-document", unavailable)
      await session.push({
        type: "local-load-complete",
        found: false,
        marker: { sequence: 0, heads: [] },
        backendSyncs: true,
      })
      await session.push({ type: "synchronized", result: noPeers() })
      expect(progress.state().status).toBe("unavailable")
      expect(unavailable).toHaveBeenCalledExactlyOnceWith({ documentId: id })
      await expect(r.find(id)).rejects.toThrow("unavailable")
      const remote = A.from({ count: 3 })
      await session.push({
        type: "records",
        records: extractRecords(remote),
        phase: "live",
        sequence: 1,
      })
      await session.push({
        type: "history-marker",
        marker: { sequence: 1, heads: heads(remote) },
      })
      expect(progress.state().status).toBe("ready")
      expect((await r.find<Doc>(id)).doc()).toEqual({ count: 3 })
    })

    it("does not interpret failed synchronization as absence", async () => {
      const { session, progress } = await lookup()
      await session.push({
        type: "local-load-complete",
        found: false,
        marker: { sequence: 0, heads: [] },
        backendSyncs: true,
      })
      await session.push({
        type: "synchronized",
        result: { ...noPeers(), roundId: "1", outcome: "failed" },
      })
      expect(progress.state().status).toBe("loading")
      await session.push({ type: "synchronized", result: noPeers() })
      expect(progress.state().status).toBe("unavailable")
    })

    it("treats an empty load with no connected peers as unavailable", async () => {
      const { session, progress } = await lookup()
      await session.push({
        type: "local-load-complete",
        found: false,
        backendSyncs: true,
        noPeers: true,
      })
      expect(progress.state().status).toBe("unavailable")
    })

    it("logs retryable failures and fails on nonretryable ones, releasing the session", async () => {
      const { r, id, session, progress, handle } = await lookup()
      await session.push({
        type: "failure",
        sequence: 0,
        error: new BackendError("synchronize", "io", "retry", true),
      })
      expect(progress.state().status).toBe("loading")
      await session.push({
        type: "failure",
        sequence: 1,
        error: new BackendError("open", "io", "read failed"),
      })
      expect(progress.state()).toMatchObject({
        status: "failed",
        error: { message: "read failed" },
      })
      // The failed session is released rather than left delivering data.
      await vi.waitFor(() => expect(session.closed).toBe(true))
      expect(() => handle.change(d => void (d.count = 5))).toThrow("closed")
      // A settled query is final; a later lookup starts afresh.
      expect(r.query(id)).not.toBe(progress)
      expect(r.query(id).state().status).toBe("loading")
    })

    it("fails partial loading on a nonretryable failure", async () => {
      const { r, id, session, progress } = await lookup()
      const prefix = A.from({ count: 1 })
      const complete = A.change(A.clone(prefix), doc => {
        doc.count = 2
      })
      await session.push({
        type: "records",
        records: extractRecords(prefix),
        sequence: 0,
        phase: "initial",
      })
      await session.push({
        type: "local-load-complete",
        found: true,
        marker: { sequence: 0, heads: heads(complete) },
      })
      expect(progress.state().status).toBe("loading")
      const waiting = r.find(id)
      const failed = expect(waiting).rejects.toThrow("read interrupted")
      await session.push({
        type: "failure",
        sequence: 1,
        error: new BackendError("observe", "io", "read interrupted"),
      })
      expect(progress.state().status).toBe("failed")
      await failed
    })

    it("fails and closes the handle when observation ends unexpectedly", async () => {
      const { session, handle, r } = await created()
      const progress = r.query<Doc>(handle.documentId)
      await session.end()
      await vi.waitFor(() =>
        expect(progress.state()).toMatchObject({
          status: "failed",
          error: { message: "Backend observation ended" },
        })
      )
      expect(() => handle.change(d => void (d.count = 2))).toThrow("closed")
    })

    it("fails the lookup when the backend cannot open a session", async () => {
      const backend = new MemoryBackend()
      vi.spyOn(backend, "open").mockImplementation(() => {
        throw new Error("cannot open")
      })
      const r = new Repo({ backend })
      repos.push(r)
      await expect(r.find(generateAutomergeUrl())).rejects.toThrow(
        "cannot open"
      )
    })
  })

  describe("records", () => {
    it("marks inbound history before reentrant edits to a ready document", async () => {
      const initial = A.from({ count: 1 })
      const remote = A.change(A.clone(initial), d => {
        d.count = 2
      })
      const { handle, session, scripted } = await created(initial)
      const store = vi.spyOn(scripted.backend, "store")
      let write: Promise<void> | undefined
      handle.once("heads-changed", () => {
        write = handle.change(d => {
          d.count = 3
        })
      })
      const changes: number[] = []
      handle.on("change", event => {
        changes.push(event.doc!.count)
      })
      await session.push({
        type: "records",
        records: extractNewCommits(initial, remote),
        phase: "initial",
        sequence: 1,
      })
      await write
      expect(handle.doc()?.count).toBe(3)
      expect(changes).toEqual([2, 3])
      expect(store).toHaveBeenCalledOnce()
      expect(store.mock.calls[0][1]).toHaveLength(1)
      await session.push({
        type: "records",
        records: extractRecords(remote),
        phase: "live",
        sequence: 2,
      })
      expect(store).toHaveBeenCalledOnce()
      expect(handle.doc()?.count).toBe(3)
    })

    it("does not validate a record whose claimed head is already applied", async () => {
      const doc = A.from({ count: 1 })
      const { handle, session } = await created(doc)
      const before = handle.fullDoc()
      const record = extractRecords(before)[0]
      const blob = record.blob.slice()
      blob[4] ^= 0xff
      await session.push({
        type: "records",
        records: [{ ...record, blob }],
        phase: "live",
        sequence: 1,
      })
      expect(handle.fullDoc()).toBe(before)
    })

    it("applies unknown records in a batch that also contains known heads", async () => {
      let remote = A.from({ count: 1 })
      const first = extractRecords(remote)
      remote = A.change(remote, d => {
        d.count = 2
      })
      const { handle, session } = await lookup()
      await session.push({
        type: "records",
        records: first,
        phase: "initial",
        sequence: 1,
      })
      const before = handle.fullDoc()
      await session.push({
        type: "records",
        records: [...first, ...extractRecords(remote)],
        phase: "live",
        sequence: 2,
      })
      expect(handle.fullDoc()).not.toBe(before)
      expect(handle.doc()?.count).toBe(2)
    })

    it("applies new fragments and skips their later echoes", async () => {
      let remote = A.from({ count: 0 })
      for (let i = 1; i <= 2000; i++)
        remote = A.change(remote, d => {
          d.count = i
        })
      const records = extractRecords(remote)
      expect(records.some(r => r.kind === "fragment")).toBe(true)
      const { handle, session } = await lookup()
      await session.push({
        type: "records",
        records,
        phase: "initial",
        sequence: 1,
      })
      expect(handle.doc()?.count).toBe(2000)
      const loaded = handle.fullDoc()
      await session.push({
        type: "records",
        records,
        phase: "live",
        sequence: 2,
      })
      expect(handle.fullDoc()).toBe(loaded)
    })

    it("does not treat a queued, unapplied head as known", async () => {
      let remote = A.from({ count: 0 })
      const first = extractRecords(remote)
      remote = A.change(remote, d => {
        d.count = 1
      })
      const keys = new Set(first.map(recordKey))
      const second = extractRecords(remote).filter(r => !keys.has(recordKey(r)))
      const { handle, session } = await lookup()
      await session.push({
        type: "records",
        records: second,
        phase: "live",
        sequence: 1,
      })
      expect(handle.doc()?.count).toBeUndefined()
      await session.push({
        type: "records",
        records: first,
        phase: "live",
        sequence: 2,
      })
      expect(handle.doc()?.count).toBe(1)
    })
  })

  describe("peers", () => {
    it("reports authenticated sender and claimed origin separately", async () => {
      const { handle, session } = await created()
      const listener = vi.fn()
      const sub = handle.sub("count")
      sub.on("ephemeral-message", listener)
      await session.push({
        type: "ephemeral",
        sequence: 1,
        sender: { kind: "test", id: "signed-originator", path: ["relay"] },
        message: {
          messageId: "message-1",
          origin: { kind: "test", id: "original-source", path: [] },
          payload: new Uint8Array(encode({ hello: "world" })),
        },
      })
      expect(listener).toHaveBeenCalledWith({
        handle: sub,
        senderId: "signed-originator",
        originId: "original-source",
        message: { hello: "world" },
      })
    })

    it("publishes outbound ephemerals through the session with Repo's origin", async () => {
      const { handle, session } = await created()
      handle.broadcast({ hello: "there" })
      await vi.waitFor(() =>
        expect(session.publishEphemeral).toHaveBeenCalledOnce()
      )
      const envelope = session.publishEphemeral.mock.calls[0][0]
      expect(envelope.origin.kind).toBe("repo")
      const listener = vi.fn()
      handle.on("ephemeral-message", listener)
      // Our own envelope echoed back is ignored by origin.
      await session.push({
        type: "ephemeral",
        sequence: 1,
        sender: { kind: "test", id: "relay", path: [] },
        message: envelope,
      })
      expect(listener).not.toHaveBeenCalled()
    })

    it("preserves Presence observation over backend session messages", async () => {
      const { handle, session } = await created()
      const presence = new Presence<{ name: string }>({ handle })
      presence.start({ initialState: { name: "local" } })
      try {
        await session.push({
          type: "ephemeral",
          sequence: 1,
          sender: { kind: "test", id: "signed-originator", path: ["relay"] },
          message: {
            messageId: "message-1",
            origin: { kind: "test", id: "original-source", path: [] },
            payload: new Uint8Array(
              encode({
                [PRESENCE_MESSAGE_MARKER]: {
                  type: "snapshot",
                  state: { name: "remote" },
                },
              })
            ),
          },
        })
        expect(Object.values(presence.getPeerStates().value)).toEqual([
          expect.objectContaining({
            senderId: "signed-originator",
            originId: "original-source",
            value: { name: "remote" },
          }),
        ])
      } finally {
        presence.stop()
      }
    })

    it("records remote heads while loading without resolving readiness or dispatching", async () => {
      const { handle, session, progress } = await lookup()
      const advertised = [commitId("01".repeat(32))]
      const listener = vi.fn()
      handle.on("remote-heads", listener)
      await session.push(remoteHeads("peer", advertised))
      expect(listener).not.toHaveBeenCalled()
      expect(progress.state().status).toBe("loading")
      expect(handle.getSyncInfo("peer" as PeerId)?.lastHeads).toEqual(
        encodeHeads([...advertised])
      )
    })

    it("delivers the latest pre-ready report per peer once the handle is ready", async () => {
      const { r, id, session } = await lookup()
      const stale = [commitId("01".repeat(32))]
      const latest = [commitId("02".repeat(32))]
      const other = [commitId("03".repeat(32))]
      await session.push(remoteHeads("a", stale))
      await session.push(remoteHeads("a", latest))
      await session.push(remoteHeads("b", other))
      await scan(session, A.getAllChanges(A.from({ count: 1 })))
      const handle = await r.find<Doc>(id)
      const listener = vi.fn()
      handle.on("remote-heads", listener)
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(listener).toHaveBeenCalledTimes(2)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: "a",
          heads: encodeHeads([...latest]),
          timestamp: handle.getSyncInfo("a" as PeerId)?.lastSyncTimestamp,
        })
      )
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          peerId: "b",
          heads: encodeHeads([...other]),
        })
      )
    })

    it("dispatches remote heads immediately once ready", async () => {
      const { handle, session } = await created()
      const listener = vi.fn()
      handle.on("remote-heads", listener)
      const advertised = [commitId("01".repeat(32))]
      await session.push(remoteHeads("peer", advertised))
      expect(listener).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          peerId: "peer",
          heads: encodeHeads([...advertised]),
        })
      )
    })

    it("discards pre-ready reports when the document becomes unavailable", async () => {
      const { handle, session, progress } = await lookup()
      const listener = vi.fn()
      handle.on("remote-heads", listener)
      await session.push(remoteHeads("peer", [commitId("01".repeat(32))]))
      await session.push({
        type: "local-load-complete",
        found: false,
        backendSyncs: true,
        noPeers: true,
      })
      expect(progress.state().status).toBe("unavailable")
      const remote = A.from({ count: 3 })
      await session.push({
        type: "records",
        records: extractRecords(remote),
        phase: "live",
        sequence: 1,
      })
      await session.push({
        type: "history-marker",
        marker: { sequence: 1, heads: heads(remote) },
      })
      expect(progress.state().status).toBe("ready")
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(listener).not.toHaveBeenCalled()
    })

    it("discards pre-ready reports when the document is deleted", async () => {
      const { r, id, handle, session } = await lookup()
      const listener = vi.fn()
      handle.on("remote-heads", listener)
      await session.push(remoteHeads("peer", [commitId("01".repeat(32))]))
      await r.delete(id)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(listener).not.toHaveBeenCalled()
    })
  })

  describe("creation races", () => {
    it("adopts a lookup that began while backend creation was pending", async () => {
      const backend = new MemoryBackend()
      let release!: () => void
      const create = backend.create.bind(backend)
      vi.spyOn(backend, "create").mockImplementationOnce(
        async (batch, options) => {
          await new Promise<void>(resolve => {
            release = resolve
          })
          return create(batch, options)
        }
      )
      const r = new Repo({ backend })
      repos.push(r)
      const id = binaryToDocumentId(
        crypto.getRandomValues(new Uint8Array(32)) as BinaryDocumentId
      )
      const importing = r.import<Doc>(A.save(A.from({ count: 5 })), {
        docId: id,
      })
      await vi.waitFor(() => expect(release).toBeDefined())
      // The lookup's empty local load settles as unavailable with no peers;
      // creation then adopts the same entry and makes it ready.
      const progress = r.query<Doc>(id)
      const announced = vi.fn()
      r.on("document", announced)
      await vi.waitFor(() =>
        expect(progress.state().status).toBe("unavailable")
      )
      release()
      const imported = await importing
      expect(progress.state().status).toBe("ready")
      expect(await r.find<Doc>(id)).toBe(imported)
      expect(imported.doc()).toEqual({ count: 5 })
      expect(announced).toHaveBeenCalledOnce()
    })
  })
})
