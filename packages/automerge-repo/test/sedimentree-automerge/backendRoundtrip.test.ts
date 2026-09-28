// @vitest-environment node
import "@automerge/automerge"
import * as A from "@automerge/automerge/slim"
import { afterEach, describe, expect, it } from "vitest"
import {
  commitId,
  sedimentreeId,
  type SedimentreeEvent,
  type SedimentreeSession,
} from "@automerge/automerge-repo/sedimentree"
import { MemoryBackend } from "@automerge/automerge-repo/sedimentree/testing"
import {
  applyRecords,
  extractRecords,
  satisfiesCheckpoint,
} from "../../src/sedimentree/automerge/index.js"

const id = sedimentreeId("42".repeat(16))
type State = { count: number; local?: boolean }
const backends: MemoryBackend[] = []
afterEach(async () => {
  await Promise.all(backends.splice(0).map(backend => backend.close()))
})

function backend(options: ConstructorParameters<typeof MemoryBackend>[0] = {}) {
  const result = new MemoryBackend(options)
  backends.push(result)
  return result
}

function fixture() {
  let doc = A.init<State>({ actor: "aabbcc" })
  for (let i = 0; i < 8; i++)
    doc = A.change(doc, { time: 0 }, draft => {
      draft.count = i
    })
  return doc
}

async function next(iterator: AsyncIterator<SedimentreeEvent>) {
  const result = await iterator.next()
  expect(result.done).toBe(false)
  return result.value as SedimentreeEvent
}

async function load(session: SedimentreeSession, doc = A.init<State>()) {
  const iterator = session.events[Symbol.asyncIterator]()
  while (true) {
    const event = await next(iterator)
    if (event.type === "records") doc = applyRecords(doc, event.records)
    else if (event.type === "local-load-complete")
      return { doc, event, iterator }
    else throw new Error(`Unexpected initial event ${event.type}`)
  }
}

describe("Automerge through the plain backend boundary", () => {
  it("persists the complete creation history without a later edit, and reopens without write-back", async () => {
    const memory = backend({ batchRecords: 1 })
    const original = fixture()
    await memory.store(id, extractRecords(original))
    await memory.flush([id])
    const a = memory.open(id)
    const first = await load(a)
    expect(first.doc).toEqual(original)
    expect(satisfiesCheckpoint(first.doc, first.event.checkpoint.heads)).toBe(
      true
    )
    await a.close()
    const b = memory.open(id)
    const second = await load(b)
    expect(A.getHeads(second.doc)).toEqual(A.getHeads(original))
    // A no-peer sync marker follows immediately: loading didn't emit extra writes.
    const result = await b.synchronize()
    expect(await next(second.iterator)).toEqual({
      type: "synchronized",
      result,
    })
  })

  it("does not expose an arbitrary first blob as a complete initial snapshot", async () => {
    const memory = backend({ batchRecords: 1 })
    const original = fixture()
    await memory.store(id, extractRecords(original))
    const session = memory.open(id)
    const iterator = session.events[Symbol.asyncIterator]()
    let doc = A.init<State>()
    let applied = 0
    while (true) {
      const event = await next(iterator)
      if (event.type === "local-load-complete") {
        expect(applied).toBeGreaterThan(1)
        expect(satisfiesCheckpoint(doc, event.checkpoint.heads)).toBe(true)
        expect(doc).toEqual(original)
        break
      }
      if (event.type !== "records") throw new Error("Expected records")
      doc = applyRecords(doc, event.records)
      applied++
      if (applied === 1) {
        expect(A.getHeads(doc).length).toBeGreaterThan(0)
        expect(
          satisfiesCheckpoint(doc, A.getHeads(original).map(commitId))
        ).toBe(false)
      }
    }
  })

  it("reconstructs a fresh cut after overflow while preserving a concurrent local edit", async () => {
    const memory = backend({ replayEvents: 2 })
    let remote = fixture()
    await memory.store(id, extractRecords(remote))
    const slow = memory.open(id)
    let { doc, iterator } = await load(slow)
    doc = A.change(doc, { time: 0 }, draft => {
      draft.local = true
    })
    for (let i = 8; i < 12; i++) {
      remote = A.change(remote, { time: 0 }, draft => {
        draft.count = i
      })
      await memory.store(id, extractRecords(remote))
    }
    expect((await next(iterator)).type).toBe("rescan-required")
    expect((await iterator.next()).done).toBe(true)
    const reopened = await load(memory.open(id), doc)
    expect(reopened.doc.count).toBe(11)
    expect(reopened.doc.local).toBe(true)
    expect(
      satisfiesCheckpoint(reopened.doc, reopened.event.checkpoint.heads)
    ).toBe(true)
    // The local branch also survives persistence through the same contract.
    await memory.store(id, extractRecords(reopened.doc))
    await memory.flush()
    expect((await load(memory.open(id))).doc).toEqual(reopened.doc)
  })

  it("orders data before synchronization checkpoints, independently of promise resolution", async () => {
    const memory = backend()
    const session = memory.open(id)
    const empty = await load(session)
    expect(empty.event.found).toBe(false)
    expect(satisfiesCheckpoint(empty.doc, empty.event.checkpoint.heads)).toBe(
      false
    )
    const original = fixture()
    await memory.store(id, extractRecords(original))
    const round = await session.synchronize()
    expect(satisfiesCheckpoint(empty.doc, round.checkpoint.heads)).toBe(false)
    let doc = empty.doc
    while (true) {
      const event = await next(empty.iterator)
      if (event.type === "records") doc = applyRecords(doc, event.records)
      if (event.type === "synchronized") {
        expect(event.result).toEqual(round)
        expect(satisfiesCheckpoint(doc, round.checkpoint.heads)).toBe(true)
        break
      }
    }
  })
})
