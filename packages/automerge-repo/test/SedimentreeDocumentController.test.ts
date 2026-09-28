import { next as A } from "@automerge/automerge"
import { describe, expect, it, vi } from "vitest"
import {
  BackendError,
  commitId,
  sedimentreeId,
  type RecordBatch,
  type SedimentreeEvent,
  type SedimentreeId,
  type SyncRoundResult,
} from "@automerge/automerge-repo/sedimentree"
import { MemoryBackend } from "@automerge/automerge-repo/sedimentree/testing"
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge"
import { SedimentreeDocumentController } from "../src/SedimentreeDocumentController.js"
import type { DocumentId } from "../src/types.js"

const id = sedimentreeId("12".repeat(16))
const documentId = "test-document" as DocumentId
type State = { count?: number; local?: number; remote?: number }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}
const checkpoint = (doc: A.Doc<State>) => ({
  sequence: 1,
  heads: A.getHeads(doc).map(commitId),
})
const records = (doc: A.Doc<State>): SedimentreeEvent => ({
  type: "records",
  sequence: 1,
  phase: "initial",
  records: extractRecords(doc),
})
const noPeers: SyncRoundResult = {
  roundId: "1",
  outcome: "no-peers",
  peers: [],
  checkpoint: { sequence: 1, heads: [] },
}

// The real memory store, with only the delay/failure/observation controls needed
// here. Manual delivery lets tests separate promise completion from consumption.
class ControlledBackend extends MemoryBackend {
  manual = false
  writes: RecordBatch[] = []
  calls: string[] = []
  storeGate?: Promise<void>
  flushGate?: Promise<void>
  failAfterStore = 0
  failFlush = false
  lateOnClose?: SedimentreeEvent
  watches: Array<{ emit: (event: SedimentreeEvent | undefined) => void }> = []

  override async store(tree: SedimentreeId, batch: RecordBatch) {
    this.calls.push("store")
    this.writes.push(batch)
    await this.storeGate
    const fail = this.failAfterStore-- > 0
    await super.store(
      tree,
      fail ? batch.slice(0, Math.max(1, Math.floor(batch.length / 2))) : batch
    )
    if (fail) {
      // Observers can consume this self-echo before the failed receipt arrives.
      await tick()
      throw new Error("partial persistence")
    }
  }
  override async flush(ids?: readonly SedimentreeId[]) {
    this.calls.push("flush")
    await this.flushGate
    await super.flush(ids)
    if (this.failFlush) throw new Error("flush IO failure")
  }
  override async deleteLocal(tree: SedimentreeId) {
    this.calls.push("delete")
    await super.deleteLocal(tree)
  }
  override open(tree: SedimentreeId) {
    const inner = super.open(tree)
    if (!this.manual) return inner
    const pending: Array<SedimentreeEvent | undefined> = []
    let wake: (() => void) | undefined
    const watch = {
      emit(event: SedimentreeEvent | undefined) {
        pending.push(event)
        wake?.()
        wake = undefined
      },
    }
    this.watches.push(watch)
    const events = (async function* () {
      while (true) {
        if (!pending.length)
          await new Promise<void>(r => {
            wake = r
          })
        const event = pending.shift()
        if (!event) return
        yield event
      }
    })()
    return {
      events,
      synchronize: async () => noPeers,
      publishEphemeral: inner.publishEphemeral.bind(inner),
      close: async () => {
        if (this.lateOnClose) watch.emit(this.lateOnClose)
        watch.emit(undefined)
        await inner.close()
      },
    }
  }
  emit(event: SedimentreeEvent) {
    this.watches.at(-1)!.emit(event)
  }
}

function controller(backend: ControlledBackend, initialDoc?: A.Doc<State>) {
  return new SedimentreeDocumentController<State>({
    backend,
    id,
    documentId,
    initialDoc,
  })
}

describe("private sedimentree document controller", () => {
  it("persists creation without another edit, flushes, and reopens without writeback", async () => {
    const backend = new ControlledBackend()
    const first = controller(backend, A.from<State>({ count: 1 }))
    expect(first.query.peek().state).toBe("ready")
    await first.flush()
    await first.close()
    expect(backend.writes).toHaveLength(1)
    const second = controller(backend)
    await second.query.whenReady()
    expect(second.handle.doc()).toEqual({ count: 1 })
    await second.flush()
    expect(backend.writes).toHaveLength(1)
    second.handle.change(d => {
      d.count = 2
    })
    await second.flush()
    await second.close()
    const third = controller(backend)
    await third.query.whenReady()
    expect(third.handle.doc()!.count).toBe(2)
    await third.close()
    await backend.close()
  })

  it("persists an explicitly created empty document", async () => {
    const backend = new ControlledBackend()
    const c = controller(backend, A.init<State>())
    expect(c.query.peek().state).toBe("ready")
    await c.flush()
    await c.close()
    const reopened = controller(backend)
    await reopened.query.whenReady()
    expect(reopened.handle.doc()).toEqual({})
    await reopened.close()
  })

  it("does not expose a nonempty prefix as ready, nor trust a sync promise", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    const c = controller(backend)
    const doc = A.from<State>({ count: 1 })
    backend.emit(records(doc))
    await tick()
    expect(c.handle.doc()).toEqual({ count: 1 })
    expect(c.query.peek().state).toBe("loading")
    await c.synchronize()
    expect(c.query.peek().state).toBe("loading")
    backend.emit({
      type: "local-load-complete",
      found: true,
      checkpoint: checkpoint(doc),
    })
    await c.query.whenReady()
    expect(backend.writes).toHaveLength(0)
    await c.close()
  })

  it("merges concurrent loading edits and captures callback-reentrant local changes", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    const c = controller(backend)
    c.handle.change(d => {
      d.local = 1
    })
    c.handle.on("change", () => {
      if (c.handle.doc()!.remote && c.handle.doc()!.local === 1) {
        c.handle.change(d => {
          d.local = 2
        })
      }
    })
    const remote = A.from<State>({ remote: 3 })
    backend.emit(records(remote))
    backend.emit({
      type: "local-load-complete",
      found: true,
      checkpoint: checkpoint(remote),
    })
    await c.query.whenReady()
    await c.flush()
    expect(c.handle.doc()).toEqual({ local: 2, remote: 3 })
    expect(backend.writes).toHaveLength(2)
    // The callback's dependent change must survive reopening (supply remote
    // records to memory too, just as a backend delivering them would do).
    await backend.store(id, extractRecords(remote))
    await c.close()
    backend.manual = false
    const reopened = controller(backend)
    await reopened.query.whenReady()
    expect(reopened.handle.doc()).toEqual({ local: 2, remote: 3 })
    await reopened.close()
  })

  it("retains out-of-order dependencies, deduplicates delivery, and rechecks checkpoints", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    const c = controller(backend)
    const first = A.from<State>({ count: 1 })
    const second = A.change(first, d => {
      d.count = 2
    })
    const changes = A.getAllChanges(second).map(blob => {
      const decoded = A.decodeChange(blob)
      return {
        kind: "commit" as const,
        id: commitId(decoded.hash),
        parents: decoded.deps.map(commitId),
        blob,
      }
    })
    backend.emit({
      type: "records",
      sequence: 1,
      phase: "initial",
      records: [changes[1]],
    })
    backend.emit({
      type: "local-load-complete",
      found: true,
      checkpoint: checkpoint(second),
    })
    await tick()
    expect(c.query.peek().state).toBe("loading")
    backend.emit({
      type: "records",
      sequence: 2,
      phase: "live",
      records: [changes[0]],
    })
    await c.query.whenReady()
    expect(c.handle.doc()).toEqual({ count: 2 })
    backend.emit({
      type: "records",
      sequence: 3,
      phase: "live",
      records: changes,
    })
    // An unrelated unresolved dependency must not revoke the completed source.
    const unrelated = A.from<State>({ remote: 1 })
    const dependent = A.change(unrelated, d => {
      d.remote = 2
    })
    const blob = A.getLastLocalChange(dependent)!
    const decoded = A.decodeChange(blob)
    backend.emit({
      type: "records",
      sequence: 4,
      phase: "live",
      records: [
        {
          kind: "commit",
          id: commitId(decoded.hash),
          parents: decoded.deps.map(commitId),
          blob,
        },
      ],
    })
    await tick()
    expect(c.query.peek().state).toBe("ready")
    await c.flush()
    expect(backend.writes).toHaveLength(0)
    await c.close()
  })

  it("retains failed own batches despite persisted self-echo, and retries only explicitly", async () => {
    const backend = new ControlledBackend()
    backend.failAfterStore = 1
    const onError = vi.fn()
    const c = new SedimentreeDocumentController<State>({
      backend,
      id,
      documentId,
      initialDoc: A.from<State>({ count: 1 }),
      onError,
    })
    await expect(c.flush()).rejects.toThrow("flush failed")
    expect(c.lastError).toBeInstanceOf(Error)
    expect(onError).toHaveBeenCalled()
    expect(c.handle.doc()!.count).toBe(1)
    await tick()
    expect(backend.writes).toHaveLength(1)
    await c.flush()
    expect(backend.writes).toHaveLength(2)
    expect(backend.writes[1]).toEqual(backend.writes[0])
    await c.flush()
    expect(backend.writes).toHaveLength(2)
    await c.close()
  })

  it("exposes automatic failures and retries a partially persisted initial batch", async () => {
    const backend = new ControlledBackend()
    backend.failAfterStore = 1
    let doc = A.init<State>({ actor: "ab" })
    for (let count = 0; count < 10; count++) {
      doc = A.change(doc, d => {
        d.count = count
      })
    }
    expect(extractRecords(doc).length).toBeGreaterThan(1)
    const c = controller(backend, doc)
    await vi.waitFor(() =>
      expect(c.lastError?.message).toBe("partial persistence")
    )
    expect(backend.writes).toHaveLength(1)
    expect(c.handle.doc()).toEqual({ count: 9 })
    await c.flush()
    expect(backend.writes).toHaveLength(2)
    await c.close()
    const reopened = controller(backend)
    await reopened.query.whenReady()
    expect(reopened.handle.doc()).toEqual({ count: 9 })
    await reopened.close()
  })

  it("drains every captured attempt and the backend barrier before aggregating errors", async () => {
    const backend = new ControlledBackend()
    backend.failAfterStore = 2
    backend.failFlush = true
    const c = controller(backend, A.from<State>({ count: 0 }))
    c.handle.change(d => {
      d.count = 1
    })
    const error = await c.flush().catch(error => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toHaveLength(3)
    expect(backend.calls).toEqual(["store", "store", "flush"])
    backend.failFlush = false
    await c.flush()
    expect(backend.writes).toHaveLength(4)
    await c.close()
  })

  it("places overlapping flush barriers before later edits and drains failures", async () => {
    const backend = new ControlledBackend()
    const store = deferred()
    const flush = deferred()
    backend.storeGate = store.promise
    backend.flushGate = flush.promise
    backend.failAfterStore = 1
    const c = controller(backend, A.from<State>({ count: 1 }))
    const first = c.flush().catch(error => error)
    const second = c.flush().catch(error => error)
    c.handle.change(d => {
      d.count = 2
    })
    await tick()
    expect(backend.calls).toEqual(["store"])
    store.resolve()
    await tick()
    await tick()
    expect(backend.calls).toEqual(["store", "flush"])
    flush.resolve()
    expect(await first).toBeInstanceOf(AggregateError)
    expect(await second).toBeInstanceOf(AggregateError)
    await c.flush()
    expect(backend.calls.slice(0, 4)).toEqual([
      "store",
      "flush",
      "flush",
      "store",
    ])
    expect(c.handle.doc()!.count).toBe(2)
    await c.close()
  })

  it("requires consumed no-peer absence after an empty local load", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    const c = controller(backend)
    backend.emit({
      type: "local-load-complete",
      found: false,
      checkpoint: noPeers.checkpoint,
    })
    await tick()
    expect(c.query.peek().state).toBe("loading")
    backend.emit({ type: "synchronized", result: noPeers })
    await tick()
    expect(c.query.peek().state).toBe("unavailable")
    await expect(c.query.whenReady()).rejects.toThrow("unavailable")
    await c.close()
  })

  it("accepts consumed peer-unavailable absence but not peer failure", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    const c = controller(backend)
    backend.emit({
      type: "local-load-complete",
      found: false,
      checkpoint: noPeers.checkpoint,
    })
    const peer = { kind: "test", id: "peer", path: [] }
    backend.emit({
      type: "synchronized",
      result: {
        ...noPeers,
        outcome: "complete",
        peers: [{ peer, outcome: "failed" }],
      },
    })
    await tick()
    expect(c.query.peek().state).toBe("loading")
    backend.emit({
      type: "synchronized",
      result: {
        ...noPeers,
        outcome: "complete",
        peers: [{ peer, outcome: "unavailable" }],
      },
    })
    await tick()
    expect(c.query.peek().state).toBe("unavailable")
    await c.close()
  })

  it("does not turn failed lookups into absence", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    const c = controller(backend)
    backend.emit({
      type: "failure",
      sequence: 1,
      error: new BackendError("open", "io", "lookup failed", true),
    })
    backend.emit({ type: "synchronized", result: noPeers })
    await tick()
    expect(c.query.peek().state).toBe("loading")
    expect(c.lastError?.message).toBe("lookup failed")
    backend.emit({
      type: "local-load-complete",
      found: false,
      checkpoint: noPeers.checkpoint,
    })
    backend.emit({
      type: "synchronized",
      result: { ...noPeers, outcome: "failed" },
    })
    await tick()
    expect(c.query.peek().state).toBe("loading")
    await c.close()
  })

  it("rescans without clearing local state or failed jobs", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    backend.failAfterStore = 1
    const c = controller(backend)
    c.handle.change(d => {
      d.local = 7
    })
    await expect(c.flush()).rejects.toThrow()
    backend.emit({ type: "rescan-required", sequence: 10 })
    await tick()
    expect(backend.watches).toHaveLength(2)
    const remote = A.from<State>({ remote: 8 })
    backend.emit(records(remote))
    backend.emit({
      type: "local-load-complete",
      found: true,
      checkpoint: checkpoint(remote),
    })
    await c.query.whenReady()
    await c.flush()
    expect(c.handle.doc()).toEqual({ local: 7, remote: 8 })
    expect(backend.writes).toHaveLength(2)
    await c.close()
  })

  it("retains an incomplete checkpoint across a rescan", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    const c = controller(backend)
    const remote = A.from<State>({ remote: 8 })
    backend.emit({ type: "checkpoint", checkpoint: checkpoint(remote) })
    backend.emit({ type: "rescan-required", sequence: 10 })
    await tick()
    expect(backend.watches).toHaveLength(2)
    backend.emit(records(remote))
    await c.query.whenReady()
    expect(c.handle.doc()).toEqual({ remote: 8 })
    await c.close()
  })

  it("does not move its initial readiness target forward on every live checkpoint", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    const c = controller(backend)
    const first = A.from<State>({ count: 1 })
    // Fragment APIs inspect the backing history, so capture this cut before
    // advancing the shared Automerge backend to a later snapshot.
    const firstRecords = records(first)
    const firstCheckpoint = checkpoint(first)
    const later = A.change(first, d => {
      d.count = 2
    })
    backend.emit({ type: "checkpoint", checkpoint: firstCheckpoint })
    backend.emit({ type: "checkpoint", checkpoint: checkpoint(later) })
    backend.emit(firstRecords)
    await c.query.whenReady()
    expect(c.handle.doc()).toEqual({ count: 1 })
    await c.close()
  })

  it("releases its watch while close still waits for accepted persistence", async () => {
    const backend = new ControlledBackend()
    const gate = deferred()
    backend.storeGate = gate.promise
    const open = backend.open.bind(backend)
    const release = vi.fn()
    backend.open = tree => {
      const session = open(tree)
      return {
        ...session,
        close: async () => {
          release()
          await session.close()
        },
      }
    }
    const c = controller(backend, A.from<State>({ count: 1 }))
    let done = false
    const closing = c.close().then(() => {
      done = true
    })
    await tick()
    expect(release).toHaveBeenCalledOnce()
    expect(done).toBe(false)
    gate.resolve()
    await closing
    await backend.close()
  })

  it("a backend deletion fences queued, not-yet-submitted edits", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    const gate = deferred()
    backend.flushGate = gate.promise
    const c = controller(backend)
    const barrier = c.flush()
    c.handle.change(d => {
      d.local = 1
    })
    backend.emit({ type: "deleted", sequence: 1 })
    await tick()
    expect(c.handle.isDeleted()).toBe(true)
    expect(c.query.peek().state).toBe("failed")
    gate.resolve()
    await barrier
    await expect(c.close()).rejects.toThrow()
    expect(backend.writes).toHaveLength(0)
  })

  it("close fences callbacks synchronously, releases waits, and ignores late events", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    const c = controller(backend)
    const waiting = c.query.whenReady().catch(error => error)
    backend.lateOnClose = records(A.from<State>({ remote: 9 }))
    const closing = c.close()
    c.handle.change(d => {
      d.local = 1
    }) // caller misuse, still cannot write back
    await closing
    await tick()
    expect(await waiting).toBeInstanceOf(Error)
    expect(c.handle.doc()).toEqual({ local: 1 })
    expect(backend.writes).toHaveLength(0)
    await backend.store(id, extractRecords(A.from<State>({ count: 4 }))) // not closed
  })

  it("closes the session even if its persistence barrier fails", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    backend.failFlush = true
    const c = controller(backend)
    const waiting = c.query.whenReady().catch(error => error)
    backend.lateOnClose = records(A.from<State>({ remote: 9 }))
    await expect(c.close()).rejects.toThrow("Controller close failed")
    await tick()
    expect(await waiting).toBeInstanceOf(Error)
    expect(c.handle.doc()).toEqual({})
    expect(c.lastError).toBeInstanceOf(Error)
  })

  it("deletion invalidates immediately and removes after older failed attempts, still cleaning up", async () => {
    const backend = new ControlledBackend()
    backend.manual = true
    backend.failAfterStore = 1
    const gate = deferred()
    backend.storeGate = gate.promise
    const c = controller(backend, A.from<State>({ count: 1 }))
    backend.lateOnClose = records(A.from<State>({ remote: 9 }))
    const deleting = c.deleteLocal().catch(error => error)
    expect(c.document.deleted).toBe(true)
    expect(c.handle.isDeleted()).toBe(true)
    expect(c.handle.isReady()).toBe(false)
    gate.resolve()
    expect(await deleting).toBeInstanceOf(AggregateError)
    expect(backend.calls).toEqual(["store", "flush", "delete"])
    backend.manual = false
    const reopened = controller(backend)
    await expect(reopened.query.whenReady()).rejects.toThrow("unavailable")
    await reopened.close()
  })
})
