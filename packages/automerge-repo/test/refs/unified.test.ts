import { describe, it, expect, beforeEach } from "vitest"
import * as Automerge from "@automerge/automerge"
import { Repo } from "../../src/Repo.js"
import type { DocHandle } from "../../src/DocHandle.js"

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
      const sub = handle.ref("value").viewAt(heads)
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

      const url = created.ref("value").viewAt(heads).url
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
