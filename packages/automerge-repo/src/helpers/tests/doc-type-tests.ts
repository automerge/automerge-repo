import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyDocType } from "../../DocType.js"
import { parseDocumentUrl } from "../../DocumentUrl.js"
import { Repo } from "../../Repo.js"
import { DocHandle } from "../../types/DocHandle.js"
import { MemoryBackend } from "../../sedimentree/memory/MemoryBackend.js"
import type {
  RecordBatch,
  SedimentreeBackend,
} from "../../sedimentree/index.js"
import { isBoundary } from "../../sedimentree/records.js"

/** Two backends that share data: what one stores, the other can load. */
export interface BackendPair {
  a: SedimentreeBackend
  b: SedimentreeBackend
  teardown?(): void | Promise<void>
}

export interface DocTypeFixture<S> {
  docType: AnyDocType
  /** A new bare state with at least one commit and its own history. */
  create(): S
  /** One local edit to a bare state, returning the new state. */
  change(state: S): S
  /** What `repo.create(init, { docType })` is given. */
  init: unknown
  /** One local edit through the handle's API. */
  edit(handle: any): Promise<void>
  /** Defaults to one shared {@link MemoryBackend}. */
  backends?(): BackendPair | Promise<BackendPair>
}

const HEX32 = /^[0-9a-f]{64}$/
const UNKNOWN = "ab".repeat(32)

/** Acceptance tests every doc type must pass. */
export function runDocTypeTests<S>(
  name: string,
  setup: () => DocTypeFixture<S> | Promise<DocTypeFixture<S>>
): void {
  describe(`DocType acceptance tests (${name})`, () => {
    let f: DocTypeFixture<S>
    let docType: AnyDocType
    beforeEach(async () => {
      f = await setup()
      docType = f.docType
    })

    /** An independent state with the same history. */
    const copy = (state: S): S =>
      docType.apply(undefined, docType.recordsSince(state, []))
    const heads = (state: S) => [...docType.heads(state)].sort()

    describe("state", () => {
      it("creates a state with heads it has", () => {
        const state = f.create()
        expect(docType.heads(state).length).toBeGreaterThan(0)
        for (const head of docType.heads(state)) expect(head).toMatch(HEX32)
        expect(docType.hasHeads(state, docType.heads(state))).toBe(true)
        expect(docType.hasHeads(state, [UNKNOWN])).toBe(false)
      })

      it("starts empty when applying nothing", () => {
        expect(docType.heads(docType.apply(undefined, []))).toEqual([])
      })

      it("emits well-formed records", () => {
        const state = f.change(f.create())
        const records = docType.recordsSince(state, [])
        expect(records.length).toBeGreaterThan(0)
        checkRecords(records)
      })

      it("round-trips its whole history", () => {
        const state = f.change(f.create())
        const loaded = copy(state)
        expect(heads(loaded)).toEqual(heads(state))
        expect(docType.hasHeads(loaded, docType.heads(state))).toBe(true)
      })

      it("reports only new commits since heads, even when changed in place", () => {
        const base = f.create()
        const before = copy(base)
        const baseHeads = docType.heads(base)
        const after = f.change(base)
        const delta = docType.recordsSince(after, baseHeads)
        expect(delta.length).toBeGreaterThan(0)
        checkRecords(delta)
        for (const record of delta) {
          expect(record.kind).toBe("commit")
          if (record.kind === "commit")
            expect(docType.hasHeads(before, [record.id])).toBe(false)
        }
        expect(heads(docType.apply(before, delta))).toEqual(heads(after))
        expect(docType.recordsSince(after, docType.heads(after))).toEqual([])
      })

      it("ignores records it already has", () => {
        const state = f.change(f.create())
        const target = copy(state)
        const expected = heads(target)
        const again = docType.apply(target, docType.recordsSince(state, []))
        expect(heads(again)).toEqual(expected)
      })

      it("keeps a commit pending until its parents arrive", () => {
        const base = f.create()
        const target = copy(base)
        const one = f.change(copy(base))
        const first = docType.recordsSince(one, docType.heads(base))
        const oneHeads = docType.heads(one)
        const two = f.change(one)
        const second = docType.recordsSince(two, oneHeads)
        const pending = docType.apply(target, second)
        expect(heads(pending)).toEqual(heads(base))
        expect(docType.hasHeads(pending, docType.heads(two))).toBe(false)
        const complete = docType.apply(pending, first)
        expect(heads(complete)).toEqual(heads(two))
      })

      it("converges after exchanging concurrent edits", () => {
        const base = f.create()
        const baseHeads = docType.heads(base)
        const a = f.change(copy(base))
        const b = f.change(copy(base))
        const fromA = docType.recordsSince(a, baseHeads)
        const fromB = docType.recordsSince(b, baseHeads)
        const aHeads = docType.heads(a)
        const bHeads = docType.heads(b)
        const mergedA = docType.apply(a, fromB)
        const mergedB = docType.apply(b, fromA)
        expect(heads(mergedA)).toEqual(heads(mergedB))
        expect(docType.hasHeads(mergedA, [...aHeads, ...bHeads])).toBe(true)
      })

      it("views a state at earlier heads, if it has views", () => {
        if (!docType.view) return
        const state = f.create()
        const earlier = docType.heads(state)
        const later = f.change(state)
        const view = docType.view(later, earlier)
        expect(heads(view)).toEqual([...earlier].sort())
      })

      it("bundles fragments for boundary commits, if it has fragments", () => {
        if (!docType.fragments) return
        let state = f.create()
        let boundary: string | undefined
        for (let i = 0; i < 3000 && !boundary; i++) {
          const before = docType.heads(state)
          state = f.change(state)
          boundary = docType
            .recordsSince(state, before)
            .flatMap(r =>
              r.kind === "commit" && isBoundary(r.id) ? [r.id] : []
            )[0]
        }
        expect(boundary).toBeDefined()
        const { records, absent } = docType.fragments(state, [
          boundary as any,
          UNKNOWN as any,
        ])
        expect(absent).toContain(UNKNOWN)
        checkRecords(records)
        for (const record of records) {
          expect(record.kind).toBe("fragment")
          expect(record.head).toBe(boundary)
        }
        const loaded = docType.apply(undefined, [
          ...records,
          ...docType.recordsSince(state, []),
        ])
        expect(heads(loaded)).toEqual(heads(state))
      })
    })

    describe("through a Repo", () => {
      let a: Repo
      let b: Repo
      let teardown: (() => void | Promise<void>) | undefined
      beforeEach(async () => {
        const shared = f.backends ? undefined : new MemoryBackend()
        const pair: BackendPair = shared
          ? { a: shared, b: shared }
          : await f.backends!()
        a = new Repo({ backend: pair.a })
        b = new Repo({ backend: pair.b })
        teardown = pair.teardown && (() => pair.teardown!())
      })
      afterEach(async () => {
        await Promise.allSettled([a.shutdown(), b.shutdown()])
        await teardown?.()
      })

      const create = (repo: Repo): Promise<any> =>
        repo.create(f.init as never, { docType })
      const find = (repo: Repo, url: string): Promise<any> =>
        repo.find(url as any, { docType })
      const sorted = (handle: any) => [...(handle.heads() as string[])].sort()
      /** Wait until both handles are at the same heads. */
      const converged = (x: any, y: any) =>
        vi.waitFor(() => expect(sorted(x)).toEqual(sorted(y)), {
          timeout: 5000,
          interval: 5,
        })

      it("creates a DocHandle whose URL uses its scheme", async () => {
        const handle = await create(a)
        expect(handle).toBeInstanceOf(DocHandle)
        expect(parseDocumentUrl(handle.url, docType).scheme).toBe(
          docType.scheme
        )
        expect(handle.isReady()).toBe(true)
        expect(a.handles[handle.documentId]).toBe(handle)
      })

      it("finds a document from another Repo", async () => {
        const handle = await create(a)
        await f.edit(handle)
        await a.flush()
        const found = await find(b, handle.url)
        await converged(found, handle)
        expect(found.doc()).toEqual(handle.doc())
      })

      it("delivers edits both ways, with change events", async () => {
        const handle = await create(a)
        await a.flush()
        const other = await find(b, handle.url)
        const changes = { handle: 0, other: 0 }
        handle.on("change", () => changes.handle++)
        other.on("change", () => changes.other++)
        await f.edit(handle)
        await converged(other, handle)
        expect(changes.other).toBeGreaterThan(0)
        const before = changes.handle
        await f.edit(other)
        await converged(other, handle)
        expect(changes.handle).toBeGreaterThan(before)
      })

      it("merges another document's history", async () => {
        const handle = await create(a)
        const other = await create(a)
        await f.edit(other)
        await handle.merge(other)
        expect(handle.hasHeads(other.heads())).toBe(true)
      })

      it("pins views to heads, or rejects them without views", async () => {
        const handle = await create(a)
        const heads = handle.heads()
        await f.edit(handle)
        if (!docType.view) {
          expect(() => handle.view(heads)).toThrow(/no views/)
          return
        }
        const view = handle.view(heads)
        expect(view).toBeInstanceOf(DocHandle)
        expect(view.isReadOnly()).toBe(true)
        expect(view.heads()).toEqual(heads)
        expect(handle.view(heads)).toBe(view)
        expect(view.equals(handle)).toBe(false)
        if (view.url !== handle.url) {
          const pinned = await find(a, view.url)
          expect(pinned.isReadOnly()).toBe(true)
          expect(sorted(pinned)).toEqual([...(heads as string[])].sort())
        }
      })

      it("accepts an equal doc type: same scheme", async () => {
        const handle = await create(a)
        expect(
          await a.find(handle.url as any, { docType: { ...docType } })
        ).toBe(handle)
      })

      it("rejects another doc type for the same document", async () => {
        const handle = await create(a)
        const other = { ...docType, scheme: `${docType.scheme}-x` }
        expect(() => a.query(handle.url as any, { docType: other })).toThrow(
          /of doc type .*/
        )
        expect(() => a.query(handle.documentId, { docType: other })).toThrow(
          /open as/
        )
      })
    })
  })
}

function checkRecords(records: RecordBatch): void {
  for (const record of records) {
    expect(record.blob).toBeInstanceOf(Uint8Array)
    expect(record.blob.byteLength).toBeGreaterThan(0)
    if (record.kind === "commit") {
      expect(record.id).toMatch(HEX32)
      for (const parent of record.parents) expect(parent).toMatch(HEX32)
      expect(record.parents).not.toContain(record.id)
    } else {
      expect(record.head).toMatch(HEX32)
      for (const id of record.boundary) expect(id).toMatch(HEX32)
      for (const id of record.checkpoints) expect(id).toMatch(/^[0-9a-f]{24}$/)
    }
  }
}
