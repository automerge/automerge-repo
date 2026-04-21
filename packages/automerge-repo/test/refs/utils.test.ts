import { describe, it, expect, beforeEach } from "vitest"
import * as Automerge from "@automerge/automerge"
import { Repo } from "../../src/Repo.js"
import type { DocHandle } from "../../src/DocHandle.js"
import { cursor } from "../../src/refs/utils.js"
import { encodeHeads } from "../../src/AutomergeUrl.js"
import type { AutomergeUrl } from "../../src/types.js"
import { CURSOR_MARKER } from "../../src/refs/types.js"

describe("utils", () => {
  describe("cursor", () => {
    it("should create a cursor marker", () => {
      const marker = cursor(0, 5)
      expect(marker[CURSOR_MARKER]).toBe(true)
      expect(marker.start).toBe(0)
      expect(marker.end).toBe(5)
    })

    it("should work with different positions", () => {
      const marker = cursor(10, 20)
      expect(marker[CURSOR_MARKER]).toBe(true)
      expect(marker.start).toBe(10)
      expect(marker.end).toBe(20)
    })
  })

  describe("handle.ref", () => {
    let repo: Repo
    let handle: DocHandle<any>

    beforeEach(() => {
      repo = new Repo()
      handle = repo.create()
    })

    it("should create a ref with variadic arguments", () => {
      handle.change(d => {
        d.user = { name: "Alice" }
      })

      const nameRef = handle.ref("user", "name")
      expect(nameRef.value()).toBe("Alice")
    })

    it("should work with numeric indices", () => {
      handle.change(d => {
        d.items = ["a", "b", "c"]
      })

      const itemRef = handle.ref("items", 1)
      expect(itemRef.value()).toBe("b")
    })

    it("should work with where clauses", () => {
      handle.change(d => {
        d.todos = [
          { id: "a", title: "First" },
          { id: "b", title: "Second" },
        ]
      })

      const todoRef = handle.ref("todos", { id: "b" }, "title")
      expect(todoRef.value()).toBe("Second")
    })

    it("should work with numeric indices in nested paths", () => {
      handle.change(d => {
        d.items = [{ name: "A" }, { name: "B" }]
      })

      const indexRef = handle.ref("items", 0, "name")
      expect(indexRef.value()).toBe("A")
    })

    it("should handle deep paths", () => {
      handle.change(d => {
        d.app = {
          settings: {
            theme: {
              color: "blue",
            },
          },
        }
      })

      const colorRef = handle.ref("app", "settings", "theme", "color")
      expect(colorRef.value()).toBe("blue")
    })
  })

  describe("repo.find(url) with sub-document URLs", () => {
    let repo: Repo
    let handle: DocHandle<any>

    beforeEach(() => {
      repo = new Repo()
      handle = repo.create()
    })

    it("should reconstruct a sub-handle from its URL", async () => {
      handle.change((d: any) => {
        d.user = { name: "Alice", age: 30 }
      })

      const nameRef = handle.ref("user", "name")
      const url = nameRef.url

      const foundRef = await repo.find(url)
      expect(foundRef.value()).toBe("Alice")
      expect(foundRef.url).toBe(url)
    })

    it("should handle nested paths", async () => {
      handle.change((d: any) => {
        d.app = {
          settings: {
            theme: { color: "blue" },
          },
        }
      })

      const colorRef = handle.ref("app", "settings", "theme", "color")
      const url = colorRef.url

      const foundRef = await repo.find(url)
      expect(foundRef.value()).toBe("blue")
    })

    it("should handle array indices", async () => {
      handle.change((d: any) => {
        d.todos = [
          { title: "first", done: false },
          { title: "second", done: true },
        ]
      })

      const titleRef = handle.ref("todos", 0, "title")
      const url = titleRef.url

      // Reorder array
      handle.change((d: any) => {
        d.todos.insertAt(0, { title: "zeroth", done: false })
      })

      // With numeric indices, ref still points to position 0 (now "zeroth")
      const foundRef = await repo.find(url)
      expect(foundRef.value()).toBe("zeroth")
    })

    it("should handle where clauses", async () => {
      handle.change((d: any) => {
        d.users = [
          { id: "user1", name: "Alice" },
          { id: "user2", name: "Bob" },
        ]
      })

      const aliceRef = handle.ref("users", { id: "user1" }, "name")
      const url = aliceRef.url

      const foundRef = await repo.find(url)
      expect(foundRef.value()).toBe("Alice")
    })

    it("should handle cursor ranges", async () => {
      handle.change((d: any) => {
        d.text = "hello world"
      })

      const rangeRef = handle.ref("text", cursor(0, 5))
      const url = rangeRef.url

      const foundRef = await repo.find(url)
      expect(foundRef.value()).toBe("hello")
    })

    it("should handle sub-handle URLs with heads", async () => {
      handle.change((d: any) => {
        d.counter = 1
      })

      const heads1 = Automerge.getHeads(handle.doc())
      const encodedHeads1 = encodeHeads(heads1)

      handle.change((d: any) => {
        d.counter = 2
      })

      const viewHandle = handle.view(encodedHeads1)
      const counterRef = viewHandle.ref("counter")
      const url = counterRef.url

      expect(url).toMatch(/^automerge:[^/]+\/counter#.+$/)
      expect(counterRef.value()).toBe(1)

      const foundRef = await repo.find(url)
      expect(foundRef.value()).toBe(1)
      expect(foundRef.url).toBe(url)
    })

    it("should throw on invalid URL format", async () => {
      await expect(
        repo.find("not-a-valid-url" as AutomergeUrl)
      ).rejects.toThrow()
      await expect(repo.find("wrong:abc/path" as AutomergeUrl)).rejects.toThrow()
    })
  })
})
