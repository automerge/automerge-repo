import { next as A } from "@automerge/automerge"
import { describe, expect, it, vi } from "vitest"
import { Document } from "../src/Document.js"
import { DocHandle } from "../src/DocHandle.js"
import { DocumentQuery } from "../src/DocumentQuery.js"
import { DocumentDelegate } from "../src/DocumentDelegate.js"
import { encodeHeads } from "../src/AutomergeUrl.js"
import { encode } from "../src/helpers/cbor.js"
import { Presence } from "../src/presence/Presence.js"
import { PRESENCE_MESSAGE_MARKER } from "../src/presence/constants.js"
import type { DocumentId, PeerId } from "../src/types.js"
import type { StorageId } from "../src/DocHandle.js"
import {
  BackendError,
  commitId,
  recordKey,
  sedimentreeId,
  type RecordBatch,
  type SyncRoundResult,
} from "../src/sedimentree/index.js"
import {
  applyRecords,
  extractRecords,
} from "../src/sedimentree/automerge/index.js"

function setup(
  doc = A.init<{ count: number; nested?: { value: number } }>(),
  submit = vi.fn(async (_id: unknown, _records: RecordBatch) => {}),
  created = false
) {
  const document = new Document("test" as DocumentId, doc)
  const handle = new DocHandle(document)
  const query = new DocumentQuery(handle)
  const sync = vi.fn(
    async (): Promise<SyncRoundResult> => ({
      roundId: "1",
      marker: { sequence: 0, heads: [] },
      outcome: "no-peers",
      peers: [],
    })
  )
  const delegate = new DocumentDelegate(
    sedimentreeId("01".repeat(16)),
    document,
    query,
    (id, source) => source(records => submit(id, records)),
    sync,
    created
  )
  return { document, handle, query, delegate, submit, sync }
}

describe("DocumentDelegate", () => {
  it("uses authenticated ephemeral sender, not claimed origin", () => {
    const { delegate, handle } = setup(A.from({ count: 0 }), undefined, true)
    const listener = vi.fn()
    const sub = handle.sub("count")
    sub.on("ephemeral-message", listener)
    delegate.onEvent({
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
      message: { hello: "world" },
    })
  })

  it("preserves Presence observation over backend session messages", () => {
    const { delegate, handle } = setup(A.from({ count: 0 }), undefined, true)
    const presence = new Presence<{ name: string }>({
      handle,
    })
    presence.start({ initialState: { name: "local" } })
    try {
      delegate.onEvent({
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
      expect(
        presence.getPeerStates().value["signed-originator" as PeerId]?.value
      ).toEqual({ name: "remote" })
    } finally {
      presence.stop()
    }
  })

  it("forwards remote heads as advertisements without resolving readiness", () => {
    const { delegate, handle, query } = setup()
    const heads = [commitId("01".repeat(32))]
    const listener = vi.fn()
    handle.on("remote-heads", listener)
    delegate.onEvent({
      type: "remote-heads",
      sequence: 1,
      remote: { kind: "test", id: "peer", path: [] },
      heads,
    })
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        storageId: "peer",
        heads: encodeHeads([...heads]),
      })
    )
    expect(query.peek().state).toBe("loading")
    expect(handle.getSyncInfo("peer" as StorageId)?.lastHeads).toEqual(
      encodeHeads([...heads])
    )
  })

  it("mutates and emits immediately, resolves change only after persistence", async () => {
    let resolve!: () => void
    const submit = vi.fn(
      () =>
        new Promise<void>(r => {
          resolve = r
        })
    )
    const { handle } = setup(A.from({ count: 0 }), submit, true)
    const listener = vi.fn()
    handle.on("change", listener)
    let completed = false
    const write = handle
      .change(d => {
        d.count = 1
      })
      .then(() => {
        completed = true
      })
    expect(handle.doc()?.count).toBe(1)
    expect(listener).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(completed).toBe(false)
    resolve()
    await write
    expect(completed).toBe(true)
  })

  it("gates a nonempty prefix on a complete history marker", () => {
    let remote = A.from({ count: 1 })
    const first = extractRecords(remote)
    remote = A.change(remote, d => {
      d.count = 2
    })
    const { delegate, query } = setup()
    delegate.onEvent({
      type: "records",
      records: first,
      phase: "initial",
      sequence: 1,
    })
    expect(query.peek().state).toBe("loading")
    delegate.onEvent({
      type: "local-load-complete",
      found: true,
      marker: { sequence: 1, heads: A.getHeads(remote).map(commitId) },
    })
    expect(query.peek().state).toBe("loading")
    delegate.onEvent({
      type: "records",
      records: extractRecords(remote),
      phase: "initial",
      sequence: 1,
    })
    expect(query.peek().state).toBe("ready")
  })

  it("settles an empty local cut with no peers, without permanently failing", () => {
    const { delegate, query } = setup()
    delegate.onEvent({
      type: "local-load-complete",
      found: false,
      marker: { sequence: 0, heads: [] },
    })
    delegate.onEvent({
      type: "synchronized",
      result: {
        roundId: "empty",
        marker: { sequence: 0, heads: [] },
        outcome: "no-peers",
        peers: [],
      },
    })
    expect(query.peek().state).toBe("unavailable")
    const remote = A.from({ count: 3 })
    delegate.onEvent({
      type: "records",
      records: extractRecords(remote),
      phase: "live",
      sequence: 1,
    })
    delegate.onEvent({
      type: "history-marker",
      marker: { sequence: 1, heads: A.getHeads(remote).map(commitId) },
    })
    expect(query.peek().state).toBe("ready")
  })

  it("marks inbound history before reentrant edits; does not echo records", async () => {
    const remote = A.from({ count: 1 })
    const { delegate, handle, submit } = setup()
    let write: Promise<void> | undefined
    handle.once("heads-changed", () => {
      write = handle.change(d => {
        d.count = 2
      })
    })
    const changes: number[] = []
    handle.on("change", event => {
      changes.push(event.doc!.count)
    })
    delegate.onEvent({
      type: "records",
      records: extractRecords(remote),
      phase: "initial",
      sequence: 1,
    })
    await write
    expect(handle.doc()?.count).toBe(2)
    expect(changes).toEqual([1, 2])
    expect(submit).toHaveBeenCalledOnce()
    const records = submit.mock.calls[0][1]
    expect(records).toHaveLength(1)
    expect(applyRecords(A.clone(remote), records).count).toBe(2)
    delegate.onEvent({
      type: "records",
      records: extractRecords(remote),
      phase: "live",
      sequence: 2,
    })
    expect(submit).toHaveBeenCalledOnce()
    expect(handle.doc()?.count).toBe(2)
  })

  it("skips known-head echoes without applying or acknowledging them", async () => {
    const initial = A.from({ count: 0 })
    let reject!: (error: Error) => void
    const submit = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        })
    )
    const { delegate, handle, document } = setup(initial, submit, true)
    const changed = vi.fn()
    handle.on("change", changed)
    const pending = handle.change(d => {
      d.count = 1
    })
    const echoed = submit.mock.calls[0][1]
    const before = document.doc
    delegate.onEvent({
      type: "records",
      records: echoed,
      phase: "live",
      sequence: 1,
    })
    expect(document.doc).toBe(before)
    expect(changed).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledOnce()
    reject(new Error("storage failed"))
    await expect(pending).rejects.toThrow("storage failed")
    expect(delegate.hasUnsavedHistory).toBe(true)
  })

  it("does not validate a record whose claimed head is already applied", () => {
    const doc = A.from({ count: 1 })
    const { delegate, document } = setup(doc, undefined, true)
    const record = extractRecords(doc)[0]
    const blob = record.blob.slice()
    blob[4] ^= 0xff
    delegate.onEvent({
      type: "records",
      records: [{ ...record, blob }],
      phase: "live",
      sequence: 1,
    })
    expect(document.doc).toBe(doc)
  })

  it("applies unknown records in a batch that also contains known heads", () => {
    let remote = A.from({ count: 1 })
    const first = extractRecords(remote)
    remote = A.change(remote, d => {
      d.count = 2
    })
    const { delegate, document, handle } = setup()
    delegate.onEvent({
      type: "records",
      records: first,
      phase: "initial",
      sequence: 1,
    })
    const before = document.doc
    delegate.onEvent({
      type: "records",
      records: [...first, ...extractRecords(remote)],
      phase: "live",
      sequence: 2,
    })
    expect(document.doc).not.toBe(before)
    expect(handle.doc()?.count).toBe(2)
  })

  it("applies new fragments and skips their later echoes", () => {
    let remote = A.from({ count: 0 })
    for (let i = 1; i <= 2000; i++)
      remote = A.change(remote, d => {
        d.count = i
      })
    const records = extractRecords(remote)
    expect(records.some(r => r.kind === "fragment")).toBe(true)
    const { delegate, document, handle } = setup()
    const before = document.doc
    delegate.onEvent({
      type: "records",
      records,
      phase: "initial",
      sequence: 1,
    })
    expect(handle.doc()?.count).toBe(2000)
    const loaded = document.doc
    expect(loaded).not.toBe(before)
    delegate.onEvent({ type: "records", records, phase: "live", sequence: 2 })
    expect(document.doc).toBe(loaded)
  })

  it("does not treat a queued, unapplied head as known", () => {
    let remote = A.from({ count: 0 })
    const first = extractRecords(remote)
    remote = A.change(remote, d => {
      d.count = 1
    })
    const keys = new Set(first.map(recordKey))
    const second = extractRecords(remote).filter(r => !keys.has(recordKey(r)))
    const { delegate, handle } = setup()
    delegate.onEvent({
      type: "records",
      records: second,
      phase: "live",
      sequence: 1,
    })
    expect(handle.doc()?.count).toBeUndefined()
    delegate.onEvent({
      type: "records",
      records: first,
      phase: "live",
      sequence: 2,
    })
    expect(handle.doc()?.count).toBe(1)
  })

  it("retains exact failed bytes even if a submitter modifies its copy", async () => {
    const attempts: Uint8Array[][] = []
    const submit = vi.fn(async (_id: unknown, records: RecordBatch) => {
      attempts.push(records.map(r => r.blob.slice()))
      if (attempts.length === 1) {
        records[0].blob.fill(0)
        throw new Error("disk full")
      }
    })
    const { handle, delegate } = setup(A.from({ count: 0 }), submit, true)
    await expect(
      handle.change(d => {
        d.count++
      })
    ).rejects.toThrow("disk full")
    await delegate.flush()
    expect(attempts[1]).toEqual(attempts[0])
  })

  it("retains the reason when a scheduled write rejects before preparing records", async () => {
    const reason = new Error("Document generation deleted")
    const document = new Document("test" as DocumentId, A.from({ count: 0 }))
    const handle = new DocHandle(document)
    const delegate = new DocumentDelegate(
      sedimentreeId("01".repeat(16)),
      document,
      new DocumentQuery(handle),
      () => Promise.reject(reason),
      async () => ({
        roundId: "1",
        marker: { sequence: 0, heads: [] },
        outcome: "no-peers",
        peers: [],
      }),
      true
    )
    await expect(
      handle.change(d => {
        d.count = 1
      })
    ).rejects.toBe(reason)
    await expect(delegate.flush()).rejects.toMatchObject({ errors: [reason] })
  })

  it("retries a boundary batch with its original fragment bytes", async () => {
    // Fixed actors and times make change hashes, and so fragment depths, stable.
    // A.from stamps the current time and A.clone picks a random actor.
    const initial = A.change(
      A.init<{ count: number }>({ actor: "abcdef" }),
      { time: 0 },
      doc => {
        doc.count = 0
      }
    )
    let fork = A.clone(initial, { actor: "fedcba" })
    for (let count = 1; count <= 500; count++)
      fork = A.change(fork, { time: 0 }, doc => {
        doc.count = count
      })
    expect(A.getFragmentMetadata(fork).some(meta => meta.level > 0)).toBe(true)
    const attempts: RecordBatch[] = []
    const submit = vi.fn(async (_id: unknown, records: RecordBatch) => {
      attempts.push(
        records.map(record => ({
          ...record,
          blob: record.blob.slice(),
        }))
      )
      if (attempts.length === 1) {
        records[0].blob.fill(0)
        throw new Error("disk full")
      }
    })
    const { handle, delegate } = setup(initial, submit, true)
    await expect(
      handle.update(doc => A.merge(doc, A.clone(fork)))
    ).rejects.toThrow("disk full")
    expect(attempts[0].some(record => record.kind === "fragment")).toBe(true)
    await delegate.flush()
    expect(attempts[1]).toEqual(attempts[0])
    expect(A.getHeads(applyRecords(A.clone(initial), attempts[1]))).toEqual(
      A.getHeads(fork)
    )
  })

  it("flush captures accepted writes, not subsequent edits", async () => {
    const releases: (() => void)[] = []
    const submit = vi.fn(
      () =>
        new Promise<void>(resolve => {
          releases.push(resolve)
        })
    )
    const { handle, delegate } = setup(A.from({ count: 0 }), submit, true)
    const first = handle.change(d => {
      d.count = 1
    })
    const flush = delegate.flush()
    const later = handle.change(d => {
      d.count = 2
    })
    releases[0]()
    await flush
    await first
    expect(handle.doc()?.count).toBe(2)
    releases[1]()
    await later
  })

  it("captures update, changeAt, merge, and scoped removal", async () => {
    const { handle, delegate, submit } = setup(
      A.from({ count: 0, nested: { value: 1 } }),
      undefined,
      true
    )
    const heads = handle.heads()
    await handle.update(doc =>
      A.change(doc, d => {
        d.count = 1
      })
    )
    const changedHeads = handle.changeAt(heads, d => {
      d.count = 2
    })
    expect(changedHeads).toBeDefined()
    await delegate.flush()
    const other = new DocHandle(
      new Document(
        "other" as DocumentId,
        A.change(A.clone(handle.fullDoc()), d => {
          d.count = 3
        })
      )
    )
    await handle.merge(other)
    await handle.sub("nested").remove()
    expect(submit).toHaveBeenCalledTimes(4)
    expect(handle.doc()?.nested).toBeUndefined()
  })

  it("does not interpret failed synchronization as absence", () => {
    const { delegate, query } = setup()
    delegate.onEvent({
      type: "local-load-complete",
      found: false,
      marker: { sequence: 0, heads: [] },
    })
    delegate.onEvent({
      type: "synchronized",
      result: {
        roundId: "1",
        marker: { sequence: 0, heads: [] },
        outcome: "failed",
        peers: [],
      },
    })
    expect(query.peek().state).toBe("loading")
    delegate.onEvent({
      type: "synchronized",
      result: {
        roundId: "2",
        marker: { sequence: 0, heads: [] },
        outcome: "no-peers",
        peers: [],
      },
    })
    expect(query.peek().state).toBe("unavailable")
    expect(query.peek().sources.backend).toBe("unavailable")
  })

  it("logs backend failures without poisoning a later history marker or edits", async () => {
    const { delegate, query, handle } = setup()
    delegate.onEvent({
      type: "failure",
      sequence: 0,
      error: new BackendError("synchronize", "io", "retry", true),
    })
    expect(query.peek().state).toBe("loading")
    delegate.onEvent({
      type: "failure",
      sequence: 1,
      error: new BackendError("open", "io", "read failed"),
    })
    expect(query.peek().state).toBe("unavailable")
    const remote = A.from({ count: 4 })
    delegate.onEvent({
      type: "records",
      records: extractRecords(remote),
      sequence: 2,
      phase: "live",
    })
    delegate.onEvent({
      type: "history-marker",
      marker: {
        sequence: 2,
        heads: A.getHeads(remote).map(commitId),
      },
    })
    expect(query.peek().state).toBe("ready")
    await handle.change((d: { count: number }) => {
      d.count = 5
    })
    expect(handle.doc()?.count).toBe(5)
  })

  it("preserves historical views and rejects mutation after close", async () => {
    const { handle, delegate } = setup(A.from({ count: 1 }), undefined, true)
    const view = handle.view(encodeHeads(A.getHeads(handle.fullDoc())))
    await handle.change(d => {
      d.count = 2
    })
    expect(view.doc()?.count).toBe(1)
    delegate.close()
    expect(() =>
      handle.change(d => {
        d.count = 3
      })
    ).toThrow("closed")
    expect(handle.doc()?.count).toBe(2)
  })

  it("settles failed partial loading and can later verify the complete history", async () => {
    const { delegate, query } = setup()
    const prefix = A.from({ count: 1 })
    const complete = A.change(A.clone(prefix), doc => {
      doc.count = 2
    })
    delegate.onEvent({
      type: "records",
      records: extractRecords(prefix),
      sequence: 0,
      phase: "initial",
    })
    delegate.onEvent({
      type: "local-load-complete",
      found: true,
      marker: { sequence: 0, heads: A.getHeads(complete).map(commitId) },
    })
    expect(query.peek().state).toBe("loading")
    const waiting = query.whenReady()
    const unavailable = expect(waiting).rejects.toThrow("unavailable")
    delegate.onEvent({
      type: "failure",
      sequence: 1,
      error: new BackendError("observe", "io", "read interrupted"),
    })
    expect(query.peek().state).toBe("unavailable")
    await unavailable
    delegate.onEvent({
      type: "records",
      records: extractRecords(complete),
      sequence: 2,
      phase: "live",
    })
    expect(query.peek().state).toBe("ready")
  })

  it("rescan replaces stale initial targets without discarding unsaved writes", async () => {
    const submit = vi.fn(async (_id: unknown, _records: RecordBatch) => {})
    submit.mockRejectedValueOnce(new Error("disk full"))
    const { delegate, query, handle } = setup(undefined, submit)
    delegate.onEvent({
      type: "local-load-complete",
      found: true,
      marker: { sequence: 1, heads: [commitId("ff".repeat(32))] },
    })
    await expect(
      handle.change(d => {
        d.count = 1
      })
    ).rejects.toThrow("disk full")
    const failedBytes = submit.mock.calls[0][1].map(record =>
      record.blob.slice()
    )
    delegate.onEvent({ type: "rescan-required", sequence: 2 })
    delegate.onEvent({
      type: "local-load-complete",
      found: true,
      marker: {
        sequence: 1,
        heads: A.getHeads(handle.fullDoc()).map(commitId),
      },
    })
    expect(query.peek().state).toBe("ready")
    await delegate.flush()
    expect(submit.mock.calls[1][1].map(record => record.blob)).toEqual(
      failedBytes
    )
  })

  it("writes only the new change and does not resubmit an unchanged document", async () => {
    const { handle, submit } = setup(A.from({ count: 0 }), undefined, true)
    await handle.change(doc => {
      doc.count = 1
    })
    const written = submit.mock.calls[0][1]
    expect(written).toHaveLength(1)
    await handle.change(doc => {
      doc.count = 1
    })
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
