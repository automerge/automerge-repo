import { describe, it, expect, beforeEach } from "vitest"
import * as Automerge from "@automerge/automerge"
import { Repo } from "../../src/Repo.js"
import type { DocHandle } from "../../src/DocHandle.js"
import { encodeHeads } from "../../src/AutomergeUrl.js"

/**
 * Tests for the unified DocHandle/Ref API. The idea: a "ref" is now just a
 * DocHandle scoped to a path. These tests exercise the behaviors that make
 * working with a sub-document feel like working with a whole document:
 *
 *  - `repo.find(refUrl)` returns a scoped handle directly
 *  - `subHandle.url` round-trips through the ref parser
 *  - `subHandle.on("change")` only fires when the sub-tree actually changes
 *  - `subHandle.history()` is filtered to the sub-path
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

      const sub = handle.ref("items", 0, "title")
      expect(sub.url).toBe(`${handle.url}/items/@0/title`)
    })

    it("sub-handle URLs round-trip through repo.find", () => {
      handle.change(d => {
        d.user = { name: "Alice" }
      })

      const sub = handle.ref("user", "name")
      const url = sub.url

      // Re-derive a handle via the same ref path and compare URLs
      const recreated = handle.ref("user", "name")
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
      const sub = handle.ref("value").view(encodeHeads(heads))
      expect(sub.url).toContain("#")
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

      const titleRefUrl = created.ref("items", 0, "title").url
      const found = await repo.find<string>(titleRefUrl)

      expect(found.documentId).toBe(created.documentId)
      expect(found.value()).toBe("Hello")
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

      const url = created.ref("value").view(encodeHeads(heads)).url
      const resolved = await repo.find<number>(url)

      expect(resolved.value()).toBe(1)
      expect(resolved.isReadOnly()).toBe(true)
    })
  })

  describe("change event filtering", () => {
    it("sub-handle 'change' fires only when its sub-tree changes", () => {
      handle.change(d => {
        d.a = { value: 1 }
        d.b = { value: 1 }
      })

      const subA = handle.ref("a")
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

      const titleRef = handle.ref("title")
      const observed: (string | undefined)[] = []
      titleRef.onChange(v => observed.push(v as string | undefined))

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
      expect(pinned.value()).toEqual({ value: 1 })
      expect(handle.value()).toEqual({ value: 3 })
    })

    it("a fixed-heads sub-handle also does not fire change/heads-changed", () => {
      handle.change(d => {
        d.title = "First"
      })
      const pinnedHeads = handle.heads()

      // Pinned at the path AND at heads.
      const pinnedTitle = handle.ref("title").view(pinnedHeads)

      const events: any[] = []
      pinnedTitle.on("change", p => events.push(p))
      pinnedTitle.on("heads-changed", p => events.push(p))

      handle.change(d => {
        d.title = "Second"
      })

      expect(events).toEqual([])
      expect(pinnedTitle.value()).toBe("First")
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
      const subHistory = handle.ref("a").history()
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
      const selfHistory = handle.ref().history()
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

        const ref = handle.ref("items", { id: "b" }, "value")
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
    it("retains sub-handles with listeners attached", () => {
      handle.change(d => {
        d.title = "Old"
      })

      expect((handle as any)._subHandleRetainerSize).toBe(0)

      const sub = handle.ref("title")
      const unsubscribe = sub.onChange(() => {})

      expect((handle as any)._subHandleRetainerSize).toBe(1)

      unsubscribe()
      expect((handle as any)._subHandleRetainerSize).toBe(0)
    })

    it("retains a sub-handle even if the caller drops its local reference", () => {
      handle.change(d => {
        d.title = "Old"
      })

      const events: (string | undefined)[] = []
      // Attach a listener without keeping a reference to the sub-handle.
      ;(() => {
        handle
          .ref("title")
          .onChange(v => events.push(v as string | undefined))
      })()

      expect((handle as any)._subHandleRetainerSize).toBe(1)

      handle.change(d => {
        d.title = "New"
      })

      expect(events).toEqual(["New"])
    })

    it("releases retention on removeAllListeners", () => {
      handle.change(d => {
        d.title = "Old"
      })

      const sub = handle.ref("title")
      sub.on("change", () => {})
      sub.on("heads-changed", () => {})
      expect((handle as any)._subHandleRetainerSize).toBe(1)

      sub.removeAllListeners()
      expect((handle as any)._subHandleRetainerSize).toBe(0)
    })

    it("releases retention after a once() listener fires", () => {
      handle.change(d => {
        d.title = "Old"
      })

      const sub = handle.ref("title")
      sub.once("change", () => {})
      expect((handle as any)._subHandleRetainerSize).toBe(1)

      handle.change(d => {
        d.title = "New"
      })
      expect((handle as any)._subHandleRetainerSize).toBe(0)
    })

    it("survives garbage collection if listeners are attached", async () => {
      // This only runs when the test process was started with --expose-gc
      // (e.g. `pnpm test --exec "node --expose-gc"`). Otherwise skip quietly.
      const gc = (globalThis as any).gc as (() => void) | undefined
      if (typeof gc !== "function") return

      handle.change(d => {
        d.title = "Old"
      })

      const events: (string | undefined)[] = []
      let weak: WeakRef<DocHandle<any>> | undefined
      ;(() => {
        const sub = handle.ref("title")
        weak = new WeakRef(sub)
        sub.onChange(v => events.push(v as string | undefined))
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
  })

  describe("value() vs doc()", () => {
    it("doc() returns the full document on sub-handles", () => {
      handle.change(d => {
        d.user = { name: "Alice" }
      })

      const sub = handle.ref("user", "name")
      const fullDoc = sub.doc()
      expect(fullDoc.user.name).toBe("Alice")
    })

    it("value() returns the scoped sub-value on sub-handles", () => {
      handle.change(d => {
        d.user = { name: "Alice" }
      })

      const sub = handle.ref("user", "name")
      expect(sub.value()).toBe("Alice")
    })
  })
})
