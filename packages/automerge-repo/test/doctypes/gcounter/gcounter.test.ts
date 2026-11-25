import { afterEach, describe, expect, it, vi } from "vitest"
import { Repo } from "../../../src/Repo.js"
import { automerge } from "../../../src/automerge/docType.js"
import { isHandleOf } from "../../../src/types/DocHandle.js"
import { stringifyAutomergeUrl } from "../../../src/AutomergeUrl.js"
import { defineDocType } from "../../../src/DocType.js"
import { defineExtension, provides } from "../../../src/sedimentree/index.js"
import { MemoryBackend } from "../../../src/sedimentree/memory/MemoryBackend.js"
import { gcounter, type CounterState } from "./gcounter.js"
import type { AutomergeUrl } from "../../../src/types.js"

/** A member every handle of a Repo on its backend gets. */
const describes = defineExtension<{ members: { describe(): string } }>({
  members: { describe: (_context, handle) => `handle ${handle.url}` },
})

describe("a G-Counter doc type", () => {
  const repos: Repo<any>[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map(repo => repo.shutdown()))
  })
  const repo = (backend = new MemoryBackend()) => {
    const r = new Repo({ backend })
    repos.push(r)
    return r
  }

  it("reads, changes and adds its members", async () => {
    const counter = await repo().create(5, { docType: gcounter })
    expect(counter.doc()).toBe(5)
    await counter.increment()
    await counter.increment(2)
    await counter.change(10)
    expect(counter.doc()).toBe(18)
    // @ts-expect-error not an Automerge handle
    expect(counter.sub).toBeUndefined()
  })

  it("sends its value in change events", async () => {
    const counter = await repo().create(0, { docType: gcounter })
    const seen: unknown[] = []
    counter.on("change", ({ doc }) => seen.push(doc))
    await counter.increment(3)
    expect(seen).toEqual([3])
  })

  it("has backend extension members too", async () => {
    const backend = Object.assign(new MemoryBackend(), {
      handleExtensions: provides(describes),
    })
    const r = new Repo({ backend })
    repos.push(r)
    const counter = await r.create(1, { docType: gcounter })
    expect(counter.describe()).toBe(`handle ${counter.url}`)
    await counter.increment()
    const view = counter.view(counter.heads())
    expect(view.describe()).toBe(`handle ${view.url}`)
  })

  it("throws when a member clashes with a backend extension member", async () => {
    const clashing = defineExtension<{ members: { increment(): void } }>({
      members: { increment: () => {} },
    })
    const backend = Object.assign(new MemoryBackend(), {
      handleExtensions: provides(clashing),
    })
    const r = new Repo({ backend })
    repos.push(r)
    await expect(r.create(1, { docType: gcounter })).rejects.toThrow(
      /redefines increment/
    )
  })

  it("names its doc type in URLs and requires its type to open them", async () => {
    const backend = new MemoryBackend()
    const counter = await repo(backend).create(1, { docType: gcounter })
    expect(counter.url).toMatch(/^automerge:gcounter:/)
    const other = repo(backend)
    // Typed URLs are checked at compile time too; plain strings only here.
    // @ts-expect-error a counter's URL needs its doc type
    await expect(other.find(counter.url)).rejects.toThrow(
      /of doc type gcounter/
    )
    expect((await other.find(counter.url, { docType: gcounter })).doc()).toBe(1)
    const asAutomerge = stringifyAutomergeUrl({
      documentId: counter.documentId,
    })
    await expect(
      // @ts-expect-error an Automerge document's URL is not a counter's
      other.find(asAutomerge, { docType: gcounter })
    ).rejects.toThrow(/of doc type automerge/)
  })

  it("is listed with every other document, and narrows by type", async () => {
    const r = repo()
    const counter = await r.create(1, { docType: gcounter })
    const doc = await r.create({ title: "x" })
    const handles = Object.values(r.handles)
    expect(handles).toEqual(expect.arrayContaining([counter, doc]))
    const counters = handles.filter(h => isHandleOf(h, gcounter))
    expect(counters).toEqual([counter])
    for (const h of handles)
      if (isHandleOf(h, automerge)) expect(h.fullDoc()).toEqual({ title: "x" })
  })

  it("is left out of Automerge's metrics", async () => {
    const r = repo()
    await r.create(1, { docType: gcounter })
    const doc = await r.create({ title: "x" })
    expect(Object.keys(r.metrics().documents)).toEqual([doc.documentId])
  })

  it("is not of any doc type unless it is a handle", () => {
    expect(isHandleOf({}, gcounter)).toBe(false)
    expect(isHandleOf({ "~spec": {} } as object, automerge)).toBe(false)
  })

  it("rejects Automerge-only operations", async () => {
    const r = repo()
    const counter = await r.create(1, { docType: gcounter })
    await expect(r.export(counter.url)).rejects.toThrow(/of doc type gcounter/)
    await expect(r.clone(counter as any)).rejects.toThrow(/cloned/)
    const withPath = `${counter.url}/path` as AutomergeUrl
    expect(() => r.query(withPath, { docType: gcounter })).toThrow(/no paths/)
  })

  it("opens URL paths through openPath, with heads pinned first, and rejects if it throws", async () => {
    const opened: { path: string; readOnly: boolean; doc: unknown }[] = []
    const withPaths = defineDocType({
      ...gcounter,
      name: "pathed-gcounter",
      openPath: (handle, path) => {
        if (path === "bad") throw new Error("unknown path: bad")
        opened.push({ path, readOnly: handle.isReadOnly(), doc: handle.doc() })
        return handle
      },
    })
    const backend = new MemoryBackend()
    const a = repo(backend)
    const counter = await a.create(1, { docType: withPaths })
    const initialHeads = counter.heads()
    await counter.increment(4)
    await a.flush()

    const b = repo(backend)
    const liveUrl = stringifyAutomergeUrl({
      documentId: counter.documentId,
      docType: withPaths,
      path: "sub/item",
    })
    const live = await b.find(liveUrl, { docType: withPaths })
    expect(live.doc()).toBe(5)
    expect(opened[0]).toEqual({ path: "sub/item", readOnly: false, doc: 5 })

    // When a URL has both `#heads` and `/path`, `openPath` receives the view.
    const pinnedUrl = stringifyAutomergeUrl({
      documentId: counter.documentId,
      docType: withPaths,
      path: "at-initial",
      heads: initialHeads,
    })
    const pinned = await b.find(pinnedUrl, { docType: withPaths })
    expect(pinned.isReadOnly()).toBe(true)
    expect(pinned.doc()).toBe(1)
    expect(opened[1]).toEqual({ path: "at-initial", readOnly: true, doc: 1 })

    // A throwing `openPath` rejects `find` on a fresh (loading) Repo, while
    // leaving the root document ready.
    const c = repo(backend)
    const badUrl = stringifyAutomergeUrl({
      documentId: counter.documentId,
      docType: withPaths,
      path: "bad",
    })
    await expect(c.find(badUrl, { docType: withPaths })).rejects.toThrow(
      "unknown path: bad"
    )
    expect((await c.find(counter.url, { docType: withPaths })).doc()).toBe(5)
  })

  it("does not register a document when a lookup asks for unsupported views or paths", async () => {
    const noViews = defineDocType({
      ...gcounter,
      name: "viewless-gcounter",
      view: undefined,
    })
    const backend = new MemoryBackend()
    const writer = repo(backend)
    const counter = await writer.create(1, { docType: noViews })
    await writer.flush()

    const reader = repo(backend)
    const withHeads = stringifyAutomergeUrl({
      documentId: counter.documentId,
      docType: noViews,
      heads: counter.heads(),
    })
    expect(() => reader.query(withHeads, { docType: noViews })).toThrow(
      /no views/
    )
    const withPath = stringifyAutomergeUrl({
      documentId: counter.documentId,
      docType: noViews,
      path: "sub",
    })
    expect(() => reader.query(withPath, { docType: noViews })).toThrow(
      /no paths/
    )
    expect(Object.keys(reader.handles)).toEqual([])
  })

  it("rejects invalid handles returned from openPath", async () => {
    const r = repo()
    const other = await r.create(99, { docType: gcounter })
    let rootRef: any
    let mode: "not-a-handle" | "other-doc" | "dropped-view" = "not-a-handle"
    const broken = defineDocType({
      ...gcounter,
      name: "broken-paths",
      openPath: () => {
        if (mode === "not-a-handle") return { fake: true } as any
        if (mode === "other-doc") return other
        return rootRef
      },
    })
    const counter = await r.create(1, { docType: broken })
    rootRef = counter
    const heads = counter.heads()

    mode = "not-a-handle"
    await expect(
      r.find(
        stringifyAutomergeUrl({
          documentId: counter.documentId,
          docType: broken,
          path: "a",
        }),
        { docType: broken }
      )
    ).rejects.toThrow(/must return a DocHandle/)

    mode = "other-doc"
    await expect(
      r.find(
        stringifyAutomergeUrl({
          documentId: counter.documentId,
          docType: broken,
          path: "b",
        }),
        { docType: broken }
      )
    ).rejects.toThrow(/different document/)

    mode = "dropped-view"
    await expect(
      r.find(
        stringifyAutomergeUrl({
          documentId: counter.documentId,
          docType: broken,
          path: "c",
          heads,
        }),
        { docType: broken }
      )
    ).rejects.toThrow(/preserve the view's heads/)
  })

  it("fires change, heads-changed and resolves find(url#heads) when apply mutates state in place", async () => {
    const copyInto = (
      target: CounterState | undefined,
      next: CounterState
    ): CounterState => {
      if (!target) return next
      const applied = target.applied as Map<string, any>
      const pending = target.pending as Map<string, any>
      applied.clear()
      for (const [k, v] of next.applied) applied.set(k, v)
      pending.clear()
      for (const [k, v] of next.pending) pending.set(k, v)
      return target
    }
    const mutable = defineDocType({
      ...gcounter,
      name: "mutable-gcounter",
      change: (state, amount: number, ctx) =>
        copyInto(state, gcounter.change(state, amount, ctx)),
      apply: (state, records) =>
        copyInto(state, gcounter.apply(state, records)),
    })
    const backend = new MemoryBackend()
    const a = repo(backend)
    const b = repo(backend)
    const writer = await a.create(1, { docType: mutable })
    const reader = await b.find(writer.url, { docType: mutable })
    const changes: unknown[] = []
    let headsChanged = 0
    reader.on("change", ({ doc }) => changes.push(doc))
    reader.on("heads-changed", () => headsChanged++)
    // Edit on writer: produces a future head we also ask `b.find(url#heads)` to wait for.
    const isolated = repo()
    const fork = await isolated.create(0, { docType: mutable })
    await fork.merge(writer)
    await fork.increment(4)
    const targetUrl = stringifyAutomergeUrl({
      docType: mutable,
      documentId: writer.documentId,
      heads: fork.heads(),
    })
    const waiting = b.find(targetUrl, { docType: mutable })
    await writer.merge(fork)
    await vi.waitFor(() => expect(reader.doc()).toBe(5))
    expect(changes).toEqual([5])
    expect(headsChanged).toBe(1)
    expect((await waiting).doc()).toBe(5)
  })
})

// Types, checked by `pnpm lint`.
export async function types(r: Repo) {
  const counter = await r.create(1, { docType: gcounter })
  counter.doc() satisfies number
  counter.increment(2) satisfies Promise<void>
  // @ts-expect-error a G-Counter changes by a number
  void counter.change("x")
  // @ts-expect-error `increment` takes a number
  void counter.increment("x")
  counter.view(counter.heads()).doc() satisfies number
  counter.on("change", ({ doc }) => doc satisfies number | undefined)
  const found = await r.find(counter.url, { docType: gcounter })
  found.doc() satisfies number
}
