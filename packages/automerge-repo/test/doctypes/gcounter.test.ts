import { afterEach, describe, expect, it } from "vitest"
import { Repo } from "../../src/Repo.js"
import { automerge } from "../../src/automerge/docType.js"
import { isHandleOf } from "../../src/types/DocHandle.js"
import { stringifyDocumentUrl } from "../../src/AutomergeUrl.js"
import { defineExtension, provides } from "../../src/sedimentree/index.js"
import { MemoryBackend } from "../../src/sedimentree/memory/MemoryBackend.js"
import { gcounter } from "./gcounter.js"
import type { AutomergeUrl } from "../../src/types.js"

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
    const counter = await repo().create(5, { type: gcounter })
    expect(counter.doc()).toBe(5)
    await counter.increment()
    await counter.increment(2)
    await counter.change(10)
    expect(counter.doc()).toBe(18)
    // @ts-expect-error not an Automerge handle
    expect(counter.sub).toBeUndefined()
  })

  it("sends its value in change events", async () => {
    const counter = await repo().create(0, { type: gcounter })
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
    const counter = await r.create(1, { type: gcounter })
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
    await expect(r.create(1, { type: gcounter })).rejects.toThrow(
      /redefines increment/
    )
  })

  it("keeps its scheme in URLs and requires its type to open them", async () => {
    const backend = new MemoryBackend()
    const counter = await repo(backend).create(1, { type: gcounter })
    expect(counter.url).toMatch(/^gcounter:/)
    const other = repo(backend)
    await expect(other.find(counter.url)).rejects.toThrow(/URL scheme/)
    expect((await other.find(counter.url, { type: gcounter })).doc()).toBe(1)
    const asAutomerge = stringifyDocumentUrl({
      documentId: counter.documentId,
    })
    await expect(other.find(asAutomerge, { type: gcounter })).rejects.toThrow(
      /URL scheme is automerge/
    )
  })

  it("is listed with every other document, and narrows by type", async () => {
    const r = repo()
    const counter = await r.create(1, { type: gcounter })
    const doc = await r.create({ title: "x" })
    const handles = Object.values(r.handles)
    expect(handles).toEqual(expect.arrayContaining([counter, doc]))
    const counters = handles.filter(h => isHandleOf(h, gcounter))
    expect(counters).toEqual([counter])
    for (const h of handles)
      if (isHandleOf(h, automerge)) expect(h.fullDoc()).toEqual({ title: "x" })
  })

  it("rejects Automerge-only operations", async () => {
    const r = repo()
    const counter = await r.create(1, { type: gcounter })
    await expect(r.export(counter.url)).rejects.toThrow(/URL scheme/)
    await expect(r.clone(counter as any)).rejects.toThrow(/cloned/)
    const withPath = `${counter.url}/path` as AutomergeUrl
    expect(() => r.query(withPath, { type: gcounter })).toThrow(/no paths/)
  })
})

// Types, checked by `pnpm lint`.
export async function types(r: Repo) {
  const counter = await r.create(1, { type: gcounter })
  counter.doc() satisfies number
  counter.increment(2) satisfies Promise<void>
  // @ts-expect-error a G-Counter changes by a number
  void counter.change("x")
  // @ts-expect-error `increment` takes a number
  void counter.increment("x")
  counter.view(counter.heads()).doc() satisfies number
  counter.on("change", ({ doc }) => doc satisfies number | undefined)
  const found = await r.find(counter.url, { type: gcounter })
  found.doc() satisfies number
}
