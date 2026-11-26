import { afterEach, describe, expect, it, vi } from "vitest"
import { Repo } from "../../../src/Repo.js"
import { automerge } from "../../../src/automerge/docType.js"
import { isHandleOf } from "../../../src/types/DocHandle.js"
import { documentIdToBinary } from "../../../src/DocumentId.js"
import { stringifyAutomergeUrl } from "../../../src/automerge/url.js"
import { defineDocType } from "../../../src/DocType.js"
import {
  Handle,
  type CoreHandleEvents,
  type StateChange,
} from "../../../src/Handle.js"
import { defineExtension, provides } from "../../../src/sedimentree/index.js"
import { MemoryBackend } from "../../../src/sedimentree/memory/MemoryBackend.js"
import { gcounter, type CounterState } from "./gcounter.js"
import type {
  BinaryDocumentId,
  DocumentId,
  DocumentUrl,
  UrlHeads,
} from "../../../src/types.js"

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

  it("lets a handle subclass shape or suppress change events via changeEventPayload", async () => {
    type DeltaEvents = Omit<CoreHandleEvents<number>, "change"> & {
      change: (payload: {
        handle: DeltaHandle
        doc: number
        delta: number
      }) => void
    }
    const sum = (s: CounterState | undefined) =>
      s ? [...s.applied.values()].reduce((n, c) => n + c.amount, 0) : 0
    let calls = 0
    class DeltaHandle extends Handle<number, number, DeltaEvents> {
      protected changeEventPayload(change: StateChange<CounterState>) {
        calls++
        const doc = sum(change.after)
        const delta = doc - sum(change.before)
        if (delta === 0) return undefined
        return { handle: this, doc, delta }
      }
    }
    const deltaCounter = defineDocType({
      ...gcounter,
      scheme: "delta-gcounter",
      handle: DeltaHandle,
    })
    const counter = await repo().create(1, { docType: deltaCounter })
    // No change listener attached: changeEventPayload is not called.
    await counter.change(2)
    expect(calls).toBe(0)

    const seen: { doc: number; delta: number }[] = []
    counter.on("change", ({ doc, delta }) => seen.push({ doc, delta }))
    await counter.change(0)
    await counter.change(5)
    expect(calls).toBe(2)
    expect(seen).toEqual([{ doc: 8, delta: 5 }])
  })

  it("isolates errors thrown by changeEventPayload", async () => {
    let shouldThrow = true
    class FlakyHandle extends Handle<number, number> {
      protected changeEventPayload(change: StateChange<CounterState>) {
        if (shouldThrow) throw new Error("boom")
        return super.changeEventPayload(change)
      }
    }
    const flaky = defineDocType({
      ...gcounter,
      scheme: "flaky-gcounter",
      handle: FlakyHandle,
    })
    const counter = await repo().create(1, { docType: flaky })
    const seen: number[] = []
    counter.on("change", ({ doc }) => seen.push(doc!))
    await counter.change(2)
    expect(counter.doc()).toBe(3)
    expect(seen).toEqual([])
    shouldThrow = false
    await counter.change(4)
    expect(seen).toEqual([7])
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

  it("uses its scheme in URLs and requires its type to open them", async () => {
    const backend = new MemoryBackend()
    const counter = await repo(backend).create(1, { docType: gcounter })
    expect(counter.url).toMatch(/^gcounter:/)
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

  it("rejects Automerge-only operations and non-default URLs when openUrl is omitted", async () => {
    const r = repo()
    const counter = await r.create(1, { docType: gcounter })
    await expect(r.export(counter.url)).rejects.toThrow(/of doc type gcounter/)
    await expect(r.clone(counter as any)).rejects.toThrow(/cloned/)
    const withPath = `${counter.url}/path` as DocumentUrl<"gcounter">
    expect(() => r.query(withPath, { docType: gcounter })).toThrow(
      /Invalid document URL/
    )
    const withHeads =
      `${counter.url}#${counter.heads()[0]}` as DocumentUrl<"gcounter">
    expect(() => r.query(withHeads, { docType: gcounter })).toThrow(
      /Invalid document URL/
    )
  })

  it("formats, opens and deletes arbitrary custom URL formats through formatUrl and openUrl", async () => {
    const toHex = (bytes: Uint8Array) =>
      [...bytes].map(b => b.toString(16).padStart(2, "0")).join("")
    const fromHex = (hex: string) =>
      Uint8Array.from(
        hex.match(/../g)!.map(b => parseInt(b, 16))
      ) as BinaryDocumentId
    const opened: { target: string; readOnly: boolean; doc: unknown }[] = []
    // Uses a completely custom layout: `custom-gcounter://v1/<64-hex-id>[/<target>][?at=<heads>]`
    const customUrls = defineDocType({
      ...gcounter,
      scheme: "custom-gcounter",
      formatUrl: handle => {
        const hex = toHex(documentIdToBinary(handle.documentId)!)
        const query = handle.isReadOnly()
          ? `?at=${handle.heads().join(",")}`
          : ""
        return `custom-gcounter://v1/${hex}${query}`
      },
      openUrl: url => {
        const m = url.match(
          /^custom-gcounter:\/\/v1\/([0-9a-f]{64})(?:\/([^?]+))?(?:\?(.*))?$/
        )
        if (!m) throw new Error(`bad url: ${url}`)
        const [, hex, part, query] = m
        const at = new URLSearchParams(query ?? "").get("at")
        const heads = at ? (at.split(",") as UrlHeads) : undefined
        return {
          documentId: fromHex(hex),
          heads,
          open: part
            ? handle => {
                if (part === "bad") throw new Error("unknown target: bad")
                opened.push({
                  target: part,
                  readOnly: handle.isReadOnly(),
                  doc: handle.doc(),
                })
                return handle
              }
            : undefined,
        }
      },
    })
    const backend = new MemoryBackend()
    const a = repo(backend)
    const counter = await a.create(1, { docType: customUrls })
    const initialHeads = counter.heads()
    await counter.increment(4)
    await a.flush()

    const hex = toHex(documentIdToBinary(counter.documentId)!)
    expect(counter.url).toBe(`custom-gcounter://v1/${hex}`)
    const view = counter.view(initialHeads)
    expect(view.url).toBe(
      `custom-gcounter://v1/${hex}?at=${initialHeads.join(",")}`
    )

    const b = repo(backend)
    const roundTripped = await b.find(view.url, { docType: customUrls })
    expect(roundTripped.isReadOnly()).toBe(true)
    expect(roundTripped.doc()).toBe(1)

    const liveUrl =
      `custom-gcounter://v1/${hex}/sub/item` as DocumentUrl<"custom-gcounter">
    const live = await b.find(liveUrl, { docType: customUrls })
    expect(live.doc()).toBe(5)
    expect(opened[0]).toEqual({ target: "sub/item", readOnly: false, doc: 5 })

    // When a URL has both a target and heads, `open` receives the view.
    const pinnedUrl =
      `custom-gcounter://v1/${hex}/at-initial?at=${initialHeads.join(",")}` as DocumentUrl<"custom-gcounter">
    const pinned = await b.find(pinnedUrl, { docType: customUrls })
    expect(pinned.isReadOnly()).toBe(true)
    expect(pinned.doc()).toBe(1)
    expect(opened[1]).toEqual({
      target: "at-initial",
      readOnly: true,
      doc: 1,
    })

    // Sync syntax error in `openUrl` throws before registering the document.
    const c = repo(backend)
    expect(() =>
      c.query("custom-gcounter://bad" as DocumentUrl<"custom-gcounter">, {
        docType: customUrls,
      })
    ).toThrow("bad url: custom-gcounter://bad")
    // Invalid base58check heads returned by `openUrl` also fail before registering.
    expect(() =>
      c.query(
        `custom-gcounter://v1/${hex}?at=not-valid-base58` as DocumentUrl<"custom-gcounter">,
        { docType: customUrls }
      )
    ).toThrow(/Invalid heads/)
    expect(Object.keys(c.handles)).toEqual([])

    // A throwing `open` rejects `find` on a fresh (loading) Repo, while
    // leaving the root document ready.
    const badUrl =
      `custom-gcounter://v1/${hex}/bad` as DocumentUrl<"custom-gcounter">
    await expect(c.find(badUrl, { docType: customUrls })).rejects.toThrow(
      "unknown target: bad"
    )
    expect((await c.find(counter.url, { docType: customUrls })).doc()).toBe(5)

    // Repo.delete accepts custom-format URLs when `{ docType }` is passed.
    await c.delete(counter.url, { docType: customUrls })
    expect(Object.keys(c.handles)).toEqual([])
  })

  it("does not register a document when a lookup asks for unsupported views or malformed URLs", async () => {
    const noViews = defineDocType({
      ...gcounter,
      scheme: "viewless-gcounter",
      view: undefined,
      openUrl: url => {
        const [, body] = url.split("viewless-gcounter:")
        const [docId, head] = body.split("#")
        return {
          documentId: docId as DocumentId,
          heads: head ? ([head] as UrlHeads) : undefined,
        }
      },
    })
    const noOpenUrl = defineDocType({
      ...gcounter,
      scheme: "bare-gcounter",
    })
    const backend = new MemoryBackend()
    const writer = repo(backend)
    const counter = await writer.create(1, { docType: noViews })
    await writer.flush()

    const reader = repo(backend)
    const withHeads =
      `viewless-gcounter:${counter.documentId}#${counter.heads()[0]}` as DocumentUrl<"viewless-gcounter">
    expect(() => reader.query(withHeads, { docType: noViews })).toThrow(
      /no views/
    )
    const withSuffix =
      `bare-gcounter:${counter.documentId}/sub` as DocumentUrl<"bare-gcounter">
    expect(() => reader.query(withSuffix, { docType: noOpenUrl })).toThrow(
      /Invalid document URL/
    )
    expect(Object.keys(reader.handles)).toEqual([])
  })

  it("rejects invalid handles returned from openUrl and invalid URLs from formatUrl", async () => {
    const r = repo()
    const other = await r.create(99, { docType: gcounter })
    let rootRef: any
    let mode: "not-a-handle" | "other-doc" | "dropped-view" = "not-a-handle"
    const broken = defineDocType({
      ...gcounter,
      scheme: "broken-urls",
      openUrl: url => {
        const [, body] = url.split("broken-urls:")
        const [docAndPath, head] = body.split("#")
        const [docId] = docAndPath.split("/")
        return {
          documentId: docId as DocumentId,
          heads: head ? ([head] as UrlHeads) : undefined,
          open: () => {
            if (mode === "not-a-handle") return { fake: true } as any
            if (mode === "other-doc") return other
            return rootRef
          },
        }
      },
    })
    const counter = await r.create(1, { docType: broken })
    rootRef = counter
    const heads = counter.heads()

    mode = "not-a-handle"
    await expect(
      r.find(
        `broken-urls:${counter.documentId}/a` as DocumentUrl<"broken-urls">,
        { docType: broken }
      )
    ).rejects.toThrow(/must return a DocHandle/)

    mode = "other-doc"
    await expect(
      r.find(
        `broken-urls:${counter.documentId}/b` as DocumentUrl<"broken-urls">,
        { docType: broken }
      )
    ).rejects.toThrow(/different document/)

    mode = "dropped-view"
    await expect(
      r.find(
        `broken-urls:${counter.documentId}/c#${heads[0]}` as DocumentUrl<"broken-urls">,
        { docType: broken }
      )
    ).rejects.toThrow(/preserve the view's heads/)

    const badFormat = defineDocType({
      ...gcounter,
      scheme: "bad-format",
      formatUrl: () => "wrong-scheme:123",
      openUrl: () => ({ documentId: counter.documentId }),
    })
    const badHandle = await r.create(1, { docType: badFormat })
    expect(() => badHandle.url).toThrow(/formatUrl for bad-format/)

    const formatOnly = defineDocType({
      ...gcounter,
      scheme: "format-only",
      formatUrl: handle => `format-only:${handle.documentId}`,
    })
    await expect(r.create(1, { docType: formatOnly })).rejects.toThrow(
      /formatUrl without openUrl/
    )
  })

  it("fires change, heads-changed and resolves find(url with heads) when apply mutates state in place", async () => {
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
      scheme: "mutable-gcounter",
      change: (state, amount: number, ctx) =>
        copyInto(state, gcounter.change(state, amount, ctx)),
      apply: (state, records) =>
        copyInto(state, gcounter.apply(state, records)),
      openUrl: url => {
        const [, body] = url.split("mutable-gcounter:")
        const [docId, headsStr] = body.split("#")
        return {
          documentId: docId as DocumentId,
          heads: headsStr ? (headsStr.split("|") as UrlHeads) : undefined,
        }
      },
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
    // Edit on writer: produces a future head we also ask `b.find` to wait for.
    const isolated = repo()
    const fork = await isolated.create(0, { docType: mutable })
    await fork.merge(writer)
    await fork.increment(4)
    const targetUrl =
      `mutable-gcounter:${writer.documentId}#${fork.heads().join("|")}` as DocumentUrl<"mutable-gcounter">
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
