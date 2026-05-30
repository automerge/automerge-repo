import { describe, it, expect, beforeEach } from "vitest"
import * as Automerge from "@automerge/automerge"
import { Repo } from "../../src/Repo.js"
import type { DocHandle } from "../../src/DocHandle.js"
import { encodeHeads } from "../../src/AutomergeUrl.js"
import { splice } from "../../src/index.js"
import { cursor } from "../../src/subdoc-handles/utils.js"

/**
 * Tests for the unified DocHandle/Ref API. The idea: a "ref" is now just a
 * DocHandle scoped to a path. These tests exercise the behaviors that make
 * working with a sub-document feel like working with a whole document:
 *
 *  - `repo.find(refUrl)` returns a scoped handle directly
 *  - `subHandle.url` round-trips through the ref parser
 *  - `subHandle.on("change")` only fires when the sub-tree actually changes
 *  - `subHandle.history()` is filtered to the sub-path
 *
 */
describe("unified DocHandle / Ref", () => {
  let repo: Repo
  let handle: DocHandle<any>

  beforeEach(() => {
    repo = new Repo()
    handle = repo.create<any>()
  })

  describe("DocHandle.url round-trip", () => {
    it("sub-handle URL uses ref URL format", () => {
      handle.change(d => {
        d.items = [{ title: "First" }, { title: "Second" }]
      })

      const sub = handle.sub("items", 0, "title")
      expect(sub.url).toBe(`${handle.url}/items/@0/title`)
    })

    it("sub-handle URLs round-trip through repo.find", () => {
      handle.change(d => {
        d.user = { name: "Alice" }
      })

      const sub = handle.sub("user", "name")
      const url = sub.url

      // Re-derive a handle via the same ref path and compare URLs
      const recreated = handle.sub("user", "name")
      expect(recreated.url).toBe(url)
      expect(recreated.equals(sub)).toBe(true)
    })

    it("root handle URL remains an AutomergeUrl", () => {
      expect(handle.url.startsWith("automerge:")).toBe(true)
      expect(handle.url.includes("/")).toBe(false)
    })

    it("sub-handle at heads includes the heads section", () => {
      handle.change(d => {
        d.value = 1
      })
      const heads = Automerge.getHeads(handle.doc())
      const sub = handle.sub("value").view(encodeHeads(heads))
      expect(sub.url).toContain("#")
    })
  })

  describe("handle cache identity", () => {
    it("composes view() and ref() in either order to the same handle", () => {
      handle.change(d => {
        d.value = 1
      })
      const heads = handle.heads()

      const a = handle.view(heads).sub("value")
      const b = handle.sub("value").view(heads)

      expect(a).toBe(b)
      expect(a.url).toBe(b.url)
    })

    it("repeated view() calls at the same heads return the same handle", () => {
      handle.change(d => {
        d.title = "frozen"
      })
      const heads = handle.heads()

      const v1 = handle.view(heads)
      const v2 = handle.view(heads)
      expect(v1).toBe(v2)
    })

    it("view-pinned doc() returns a stable identity (memoized per underlying)", () => {
      handle.change(d => (d.value = 1))
      const heads = handle.heads()
      handle.change(d => (d.value = 2))

      const v = handle.view(heads)
      const d1 = v.doc()
      const d2 = v.doc()
      // Same underlying doc, same fixed heads => same snapshot identity.
      expect(d1).toBe(d2)
    })

    it("view([h2,h1]) and view([h1,h2]) return the same handle", () => {
      handle.change(d => (d.value = 1))
      const a = handle.heads()![0]
      handle.change(d => (d.value = 2))
      const b = handle.heads()![0]
      const v1 = handle.view([a, b] as any)
      const v2 = handle.view([b, a] as any)
      expect(v1).toBe(v2)
    })

    it("different heads on the same path produce different handles", () => {
      handle.change(d => {
        d.value = 1
      })
      const heads1 = handle.heads()
      handle.change(d => {
        d.value = 2
      })
      const heads2 = handle.heads()

      const v1 = handle.sub("value").view(heads1)
      const v2 = handle.sub("value").view(heads2)
      expect(v1).not.toBe(v2)
      expect(v1.doc()).toBe(1)
      expect(v2.doc()).toBe(2)
    })
  })

  describe("repo.find(refUrl)", () => {
    it("resolves a root handle via its automerge URL", async () => {
      const created = repo.create<any>()
      created.change(d => {
        d.hello = "world"
      })

      const found = await repo.find<any>(created.url)
      expect(found).toBe(created)
      expect(found.doc().hello).toBe("world")
    })

    it("resolves a sub-handle via a ref URL", async () => {
      const created = repo.create<any>()
      created.change(d => {
        d.items = [{ title: "Hello" }, { title: "World" }]
      })

      const titleRefUrl = created.sub("items", 0, "title").url
      const found = await repo.find<string>(titleRefUrl)

      expect(found.documentId).toBe(created.documentId)
      expect(found.doc()).toBe("Hello")
      expect(found.path.map(s => (s as any).key ?? (s as any).index)).toEqual([
        "items",
        0,
        "title",
      ])
    })

    it("resolves a sub-handle at heads via a ref URL", async () => {
      const created = repo.create<any>()
      created.change(d => {
        d.value = 1
      })
      const heads = Automerge.getHeads(created.doc())
      created.change(d => {
        d.value = 2
      })

      const url = created.sub("value").view(encodeHeads(heads)).url
      const resolved = await repo.find<number>(url)

      expect(resolved.doc()).toBe(1)
      expect(resolved.isReadOnly()).toBe(true)
    })
  })

  describe("document lifecycle", () => {
    it("delete() on a sub-handle deletes the whole document", () => {
      handle.change(d => (d.a = { x: 1 }))
      const sub = handle.sub("a")
      expect(handle.isDeleted()).toBe(false)
      expect(sub.isDeleted()).toBe(false)

      const events: DocHandle<any>[] = []
      handle.on("delete", ({ handle: h }) => events.push(h))
      sub.on("delete", ({ handle: h }) => events.push(h))

      sub.delete()

      // Both observers fire on a single delete().
      expect(events.length).toBe(2)
      // The document's deleted flag is now set, so every handle on it
      // reports `isDeleted()` true.
      expect(handle.isDeleted()).toBe(true)
      expect(sub.isDeleted()).toBe(true)
    })

    it("emit('delete') is local-only (does not flip the document flag)", () => {
      // emit() is a low-level local-dispatch primitive. Only delete()
      // performs the document-level lifecycle transition.
      handle.emit("delete", { handle })
      expect(handle.isDeleted()).toBe(false)
    })
  })

  describe("change event filtering", () => {
    it("sub-handle 'change' fires only when its sub-tree changes", () => {
      handle.change(d => {
        d.a = { value: 1 }
        d.b = { value: 1 }
      })

      const subA = handle.sub("a")
      const events: any[] = []
      subA.on("change", payload => events.push(payload))

      handle.change(d => {
        d.b.value = 2
      })
      expect(events.length).toBe(0)

      handle.change(d => {
        d.a.value = 2
      })
      expect(events.length).toBe(1)
      expect(events[0].handle).toBe(subA)
    })

    it("onChange receives the scoped value", () => {
      handle.change(d => {
        d.title = "Old"
      })

      const titleRef = handle.sub("title")
      const observed = []
      titleRef.on("change", ({ doc }) => observed.push(doc))

      handle.change(d => {
        d.title = "New"
      })

      expect(observed).toEqual(["New"])
    })

    it("a fixed-heads handle does not fire change/heads-changed when the underlying doc moves forward", () => {
      handle.change(d => {
        d.value = 1
      })
      const pinnedHeads = handle.heads()
      const pinned = handle.view(pinnedHeads)

      const changeEvents: any[] = []
      const headsEvents: any[] = []
      pinned.on("change", p => changeEvents.push(p))
      pinned.on("heads-changed", p => headsEvents.push(p))

      // The live doc continues to evolve. The pinned view is a frozen
      // snapshot at `pinnedHeads`; its content cannot change, so no
      // `change` or `heads-changed` should fire on it.
      handle.change(d => {
        d.value = 2
      })
      handle.change(d => {
        d.value = 3
      })

      expect(changeEvents).toEqual([])
      expect(headsEvents).toEqual([])

      // Sanity: the live root still sees the events.
      expect(pinned.doc()).toEqual({ value: 1 })
      expect(handle.doc()).toEqual({ value: 3 })
    })

    it("a fixed-heads sub-handle also does not fire change/heads-changed", () => {
      handle.change(d => {
        d.title = "First"
      })
      const pinnedHeads = handle.heads()

      // Pinned at the path AND at heads.
      const pinnedTitle = handle.sub("title").view(pinnedHeads)

      const events: any[] = []
      pinnedTitle.on("change", p => events.push(p))
      pinnedTitle.on("heads-changed", p => events.push(p))

      handle.change(d => {
        d.title = "Second"
      })

      expect(events).toEqual([])
      expect(pinnedTitle.doc()).toBe("First")
    })

    it("a dormant pattern ref refreshes .prop lazily on value()", () => {
      // No listener attached anywhere. This ref is "dormant" - it's
      // cached in the trie but its pattern edge hasn't been touched by
      // dispatch. Without lazy refresh on read, `path[i].prop` could
      // be stale (or never resolved) until a listener triggered dispatch.
      handle.change(d => {
        d.items = [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
          { id: "c", value: 3 },
        ]
      })

      const ref = handle.sub("items", { id: "b" }, "value")
      // Initial resolution (from #normalizePath at construction): b is at 1.
      expect(ref.path[1].prop).toBe(1)
      expect(ref.doc()).toBe(2)

      // Shift the array so b moves to 0. No listeners on ref, so nothing
      // refreshes during dispatch. This tests the "dormant refs are free"
      // path.
      handle.change(d => {
        d.items.shift()
      })

      // value() triggers lazy refresh via scopedValue -> updatePropsFromRoot.
      expect(ref.doc()).toBe(2)
      expect(ref.path[1].prop).toBe(0)
    })

    it("sub-handle change payload.doc is the scoped value, not the whole doc", () => {
      handle.change(d => {
        d.user = { name: "Alice", age: 30 }
        d.unrelated = "x"
      })

      const userRef = handle.sub("user")
      const payloads: any[] = []
      userRef.on("change", p => payloads.push(p))

      handle.change(d => {
        d.user.age = 31
      })

      expect(payloads.length).toBe(1)
      // doc is scoped to the sub-handle's path...
      expect(payloads[0].doc).toEqual({ name: "Alice", age: 31 })
      // ...not the whole document.
      expect(payloads[0].doc.unrelated).toBeUndefined()
      // patches stay scoped too.
      expect(payloads[0].patches.length).toBeGreaterThan(0)
    })

    it("sub-handle heads-changed payload.doc is the whole document", () => {
      // Unlike `change` (scoped), `heads-changed` is a document-level event:
      // heads move for the whole doc, so the payload carries the full doc.
      handle.change(d => {
        d.user = { name: "Alice" }
        d.unrelated = "x"
      })

      const userRef = handle.sub("user")
      const payloads: any[] = []
      userRef.on("heads-changed", p => payloads.push(p))

      handle.change(d => {
        d.unrelated = "y"
      })

      expect(payloads.length).toBe(1)
      expect(payloads[0].doc).toEqual({
        user: { name: "Alice" },
        unrelated: "y",
      })
    })
  })

  describe("live vs historical resolution", () => {
    it("changeAt resolves a pattern path against the historical doc, not the live one", () => {
      handle.change(d => {
        d.items = [
          { id: "a", n: 1 },
          { id: "b", n: 2 },
        ]
      })
      const oldHeads = handle.heads()

      // Insert a new item at the front in the live doc, shifting id "a"
      // from index 0 to index 1.
      handle.change(d => {
        d.items.splice(0, 0, { id: "z", n: 0 })
      })
      expect(handle.doc().items.map((i: any) => i.id)).toEqual(["z", "a", "b"])

      // changeAt at the OLD heads, where id "a" is still at index 0. The
      // pattern must resolve against that historical doc, not the live one
      // (where index 1 historically held "b").
      const aRef = handle.sub("items", { id: "a" })
      aRef.changeAt(oldHeads, (item: any) => {
        item.n = 99
      })

      const a = handle.doc().items.find((i: any) => i.id === "a")
      const b = handle.doc().items.find((i: any) => i.id === "b")
      expect(a.n).toBe(99)
      expect(b.n).toBe(2)
    })

    it("cursor refs on a pinned view resolve against the historical text", () => {
      handle.change(d => {
        d.text = "hello world"
      })
      const oldHeads = handle.heads()

      // Prepend to the live text so positions shift relative to the old view.
      handle.change(d => {
        splice(d, ["text"], 0, 0, ">>>")
      })
      expect(handle.doc().text).toBe(">>>hello world")

      // The cursor range must be created from - and read back against - the
      // pinned view's text ("hello world"), not the live text.
      const pinned = handle.view(oldHeads)
      const rangeRef = pinned.sub("text", cursor(0, 5))

      expect(rangeRef.doc()).toBe("hello")
    })
  })

  describe("unresolvable paths", () => {
    it("pattern matching skips non-object array items instead of throwing", () => {
      handle.change(d => {
        // Mixed array: nulls and primitives alongside objects.
        d.items = [null, 1, "x", { id: "a", n: 1 }, { id: "b", n: 2 }]
      })

      // Resolution must not throw on the null/primitive items.
      const aRef = handle.sub("items", { id: "a" })
      expect(aRef.doc()).toEqual({ id: "a", n: 1 })

      // A non-matching pattern simply resolves to nothing.
      const missing = handle.sub("items", { id: "nope" })
      expect(missing.doc()).toBeUndefined()
    })

    it("reads on an unresolvable (no-match) path return undefined", () => {
      handle.change(d => {
        d.items = [{ id: "a" }]
      })
      expect(handle.sub("items", { id: "nope" }, "x").doc()).toBeUndefined()
    })

    it("change() on an unresolvable (no-match) path throws rather than no-op", () => {
      handle.change(d => {
        d.items = [{ id: "a", n: 1 }]
      })

      const ghost = handle.sub("items", { id: "nope" })
      expect(() => ghost.change((v: any) => ({ ...v, n: 5 }))).toThrow(
        /does not resolve/i
      )
      // The document is untouched.
      expect(handle.doc().items).toEqual([{ id: "a", n: 1 }])
    })

    it("remove() on an unresolvable (no-match) path throws rather than no-op", () => {
      handle.change(d => {
        d.items = [{ id: "a", n: 1 }]
      })

      const ghost = handle.sub("items", { id: "nope" })
      expect(() => ghost.remove()).toThrow(/does not resolve/i)
      expect(handle.doc().items).toEqual([{ id: "a", n: 1 }])
    })

    it("change() can still create an absent literal key (keys resolve symbolically)", () => {
      handle.change(d => {
        d.data = {}
      })
      // "missing" doesn't exist yet, but a literal key always resolves -
      // so this creates it rather than throwing.
      handle.sub("data", "missing").change(() => "now exists")
      expect(handle.doc().data.missing).toBe("now exists")
    })
  })

  describe("pattern dispatch under array mutation", () => {
    // A pattern sub-handle (`{ id }`) must be notified when its matched
    // element's *presence* changes - appears, disappears, or is replaced -
    // not only when its contents change. Dispatch that resolves patterns
    // against the after-state only will miss disappearances (the element is
    // gone, so nothing matches) and can misroute a sibling's patch.

    it("fires a change when the matched element is deleted", () => {
      handle.change(d => {
        d.items = [
          { id: "a", v: 1 },
          { id: "b", v: 2 },
        ]
      })
      const subB = handle.sub("items", { id: "b" })
      const events: any[] = []
      subB.on("change", p => events.push(p))

      handle.change(d => {
        d.items.deleteAt(1) // remove the { id: "b" } element
      })

      expect(events.length).toBeGreaterThan(0)
      expect(events[events.length - 1].scopeReplaced).toBe(true)
      expect(subB.doc()).toBeUndefined()
    })

    it("fires a change when the matched element stops matching", () => {
      handle.change(d => {
        d.items = [{ id: "b", v: 2 }]
      })
      const subB = handle.sub("items", { id: "b" })
      const events: any[] = []
      subB.on("change", p => events.push(p))

      handle.change(d => {
        d.items[0].id = "z" // { id: "b" } no longer matches anything
      })

      expect(events.length).toBeGreaterThan(0)
      expect(subB.doc()).toBeUndefined()
    })

    it("fires a change when a matching element appears", () => {
      handle.change(d => {
        d.items = [{ id: "a" }]
      })
      const subZ = handle.sub("items", { id: "z" })
      const events: any[] = []
      subZ.on("change", p => events.push(p))

      handle.change(d => {
        d.items.push({ id: "z", v: 9 })
      })

      expect(events.length).toBeGreaterThan(0)
      expect(subZ.doc()).toEqual({ id: "z", v: 9 })
    })

    it("deleting a sibling notifies the deleted element and preserves survivors", () => {
      handle.change(d => {
        d.items = [
          { id: "a", v: 1 },
          { id: "b", v: 2 },
        ]
      })
      const subA = handle.sub("items", { id: "a" })
      const subB = handle.sub("items", { id: "b" })
      const aEvents: any[] = []
      const bEvents: any[] = []
      subA.on("change", p => aEvents.push(p))
      subB.on("change", p => bEvents.push(p))

      handle.change(d => {
        d.items.deleteAt(0) // delete "a"; "b" shifts from index 1 -> 0
      })

      // The deleted element's handle must be notified (was missed before).
      expect(aEvents.length).toBeGreaterThan(0)
      expect(subA.doc()).toBeUndefined()

      // The survivor's value must remain intact and uncorrupted - it must
      // not receive "a"'s deletion as one of its own content patches.
      expect(subB.doc()).toEqual({ id: "b", v: 2 })
      for (const e of bEvents) {
        for (const patch of e.patches) {
          expect(patch.action).not.toBe("del")
        }
      }
    })
  })

  describe("history() filtering on sub-handles", () => {
    it("returns only heads where the sub-path changed", () => {
      handle.change(d => {
        d.a = 1
        d.b = 1
      })

      handle.change(d => {
        d.b = 2
      })

      handle.change(d => {
        d.a = 2
      })

      const fullHistory = handle.history()
      expect(fullHistory).toBeDefined()
      const subHistory = handle.sub("a").history()
      expect(subHistory).toBeDefined()
      // Sub-history should be strictly smaller than full history because the
      // middle change only touched `b`.
      expect(subHistory!.length).toBeLessThan(fullHistory!.length)
      // There should be at least one entry (the creating change).
      expect(subHistory!.length).toBeGreaterThan(0)
    })

    it("returns the root document's full history for the root handle", () => {
      handle.change(d => {
        d.a = 1
      })
      handle.change(d => {
        d.b = 1
      })
      const rootHistory = handle.history()
      const selfHistory = handle.sub().history()
      expect(selfHistory).toEqual(rootHistory)
    })

    it(
      "includes history steps where a pattern's target existed at a " +
        "different index than it does now",
      () => {
        // Step 1: create items with target "b" at index 1.
        handle.change(d => {
          d.items = [
            { id: "a", value: 1 },
            { id: "b", value: 2 },
            { id: "c", value: 3 },
          ]
        })
        // Step 2: touch b.value at index 1 (target at index 1 here).
        handle.change(d => {
          d.items[1].value = 20
        })
        // Step 3: shift - b moves to index 0.
        handle.change(d => {
          d.items.shift()
        })
        // Step 4: touch b.value at index 0 (target at index 0 here).
        handle.change(d => {
          d.items[0].value = 200
        })
        // Step 5: unrelated change (should not appear in sub history).
        handle.change(d => {
          d.unrelated = "x"
        })

        const ref = handle.sub("items", { id: "b" }, "value")
        const subHistory = ref.history()
        expect(subHistory).toBeDefined()

        // We expect: the creating change (step 1), step 2 (touched at 1),
        // step 3 (reshape that moved b), and step 4 (touched at 0). Step 5
        // does not touch the pattern's current OR previous position and
        // should be excluded. Before the Phase 4 fix, current-heads
        // resolution would see `prop = 0` and miss step 2 (patches at
        // items[1]); resolving against each step fixes that.
        expect(subHistory!.length).toBe(4)
        expect(subHistory!.length).toBeLessThan(handle.history()!.length)
      }
    )
  })

  describe("sub-handle retention", () => {
    // Baseline: the root handle is always in the retainer set when the
    // Repo has attached its own listeners (`heads-changed` for autosave).
    // Tests assert deltas against this baseline rather than absolute counts.
    let baseline: number
    beforeEach(() => {
      baseline = (handle as any)._handleRetainerSize
    })

    it("retains sub-handles with listeners attached", () => {
      handle.change(d => {
        d.title = "Old"
      })

      expect((handle as any)._handleRetainerSize).toBe(baseline)

      const sub = handle.sub("title")
      const callback = () => {}
      sub.on("change", callback)

      expect((handle as any)._handleRetainerSize).toBe(baseline + 1)

      sub.off("change", callback)
      expect((handle as any)._handleRetainerSize).toBe(baseline)
    })

    it("retains a sub-handle even if the caller drops its local reference", () => {
      handle.change(d => {
        d.title = "Old"
      })

      const events = []
      // Attach a listener without keeping a reference to the sub-handle.
      ;(() => {
        handle.sub("title").on("change", ({ doc }) => events.push(doc))
      })()

      expect((handle as any)._handleRetainerSize).toBe(baseline + 1)

      handle.change(d => {
        d.title = "New"
      })

      expect(events).toEqual(["New"])
    })

    it("releases retention on removeAllListeners", () => {
      handle.change(d => {
        d.title = "Old"
      })

      const sub = handle.sub("title")
      sub.on("change", () => {})
      sub.on("heads-changed", () => {})
      expect((handle as any)._handleRetainerSize).toBe(baseline + 1)

      sub.removeAllListeners()
      expect((handle as any)._handleRetainerSize).toBe(baseline)
    })

    it("releases retention after a once() listener fires", () => {
      handle.change(d => {
        d.title = "Old"
      })

      const sub = handle.sub("title")
      sub.once("change", () => {})
      expect((handle as any)._handleRetainerSize).toBe(baseline + 1)

      handle.change(d => {
        d.title = "New"
      })
      expect((handle as any)._handleRetainerSize).toBe(baseline)
    })

    it("survives garbage collection if listeners are attached", async () => {
      // This only runs when the test process was started with --expose-gc
      // (e.g. `pnpm test --exec "node --expose-gc"`). Otherwise skip quietly.
      const gc = (globalThis as any).gc as (() => void) | undefined
      if (typeof gc !== "function") return

      handle.change(d => {
        d.title = "Old"
      })

      const events = []
      let weak: WeakRef<DocHandle<any>> | undefined
      ;(() => {
        const sub = handle.sub("title")
        weak = new WeakRef(sub)
        sub.on("change", v => events.push(v))
      })()

      for (let i = 0; i < 10; i++) {
        gc()
        await new Promise(r => setTimeout(r, 5))
      }

      expect(weak!.deref()).toBeDefined()

      handle.change(d => {
        d.title = "New"
      })
      expect(events).toEqual(["New"])
    })

    it("prunes trie nodes for sub-handles that are garbage-collected", async () => {
      // Only runs under --expose-gc; skip quietly otherwise.
      const gc = (globalThis as any).gc as (() => void) | undefined
      if (typeof gc !== "function") return

      handle.change(d => {
        d.items = [{ id: "seed", v: 0 }]
      })
      const baselineNodes = (handle as any)._trieNodeCount

      // Create many transient sub-handles at distinct pattern paths, holding
      // no references and attaching no listeners - they're weakly held only.
      ;(() => {
        for (let i = 0; i < 200; i++) {
          handle.sub("items", { id: `transient-${i}` }).doc()
        }
      })()

      expect((handle as any)._trieNodeCount).toBeGreaterThan(baselineNodes)

      for (let i = 0; i < 10; i++) {
        gc()
        await new Promise(r => setTimeout(r, 5))
      }

      // Once the transient handles are collected, the finalizer prunes their
      // nodes back toward the baseline (bounded by live handles).
      expect((handle as any)._trieNodeCount).toBeLessThan(baselineNodes + 50)
    })
  })
})
