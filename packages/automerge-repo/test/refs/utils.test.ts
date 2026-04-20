import { describe, it, expect, beforeEach } from "vitest"
import * as Automerge from "@automerge/automerge"
import { Repo } from "../../src/Repo.js"
import type { DocHandle } from "../../src/DocHandle.js"
import { cursor, findRef, refFromObject } from "../../src/refs/utils.js"
import { encodeHeads } from "../../src/AutomergeUrl.js"
import type { RefUrl } from "../../src/refs/types.js"
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

  describe("findRef", () => {
    let repo: Repo
    let handle: DocHandle<any>

    beforeEach(() => {
      repo = new Repo()
      handle = repo.create()
    })

    it("should reconstruct a ref from its URL", async () => {
      handle.change((d: any) => {
        d.user = { name: "Alice", age: 30 }
      })

      const nameRef = handle.ref("user", "name")
      const url = nameRef.url

      const foundRef = await findRef(repo, url)
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

      const foundRef = await findRef(repo, url)
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
      const foundRef = await findRef(repo, url)
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

      const foundRef = await findRef(repo, url)
      expect(foundRef.value()).toBe("Alice")
    })

    it("should handle cursor ranges", async () => {
      handle.change((d: any) => {
        d.text = "hello world"
      })

      const rangeRef = handle.ref("text", cursor(0, 5))
      const url = rangeRef.url

      const foundRef = await findRef(repo, url)
      expect(foundRef.value()).toBe("hello")
    })

    it("should handle refs with heads", async () => {
      handle.change((d: any) => {
        d.counter = 1
      })

      // Get heads using Automerge.getHeads (hex format) and encode to base58
      const heads1 = Automerge.getHeads(handle.doc())
      const encodedHeads1 = encodeHeads(heads1)

      handle.change((d: any) => {
        d.counter = 2
      })

      // Create a view handle at the old heads and get a ref from it
      const viewHandle = handle.view(encodedHeads1)
      const counterRef = viewHandle.ref("counter")
      const url = counterRef.url

      // Verify URL format: automerge:docId/path#head1,head2
      expect(url).toMatch(/^automerge:[^/]+\/counter#.+$/)
      expect(counterRef.value()).toBe(1) // Should see old value

      const foundRef = await findRef(repo, url)
      expect(foundRef.value()).toBe(1) // Should see old value
      expect(foundRef.url).toBe(url)
    })

    it("should throw on invalid URL format", async () => {
      await expect(findRef(repo, "not-a-valid-url" as RefUrl)).rejects.toThrow(
        "Invalid ref URL"
      )
      await expect(findRef(repo, "wrong:abc/path" as RefUrl)).rejects.toThrow(
        "Invalid ref URL"
      )
    })

    it("should handle root path (document ref)", async () => {
      handle.change((d: any) => {
        d.value = 42
      })

      const rootRef = handle.ref()
      const url = rootRef.url

      const foundRef = await findRef(repo, url)
      expect(foundRef.value()).toEqual({ value: 42 })
    })
  })

  describe("refFromObject", () => {
    let repo: Repo
    let handle: DocHandle<any>

    beforeEach(() => {
      repo = new Repo()
      handle = repo.create()
    })

    it("should create a ref from a map value", () => {
      handle.change((d: any) => {
        d.user = { name: "Alice", age: 30 }
      })

      const doc = handle.doc() as any
      const userRef = refFromObject<{ name: string; age: number }>(
        handle,
        doc.user
      )

      expect(userRef.value()).toEqual({ name: "Alice", age: 30 })
      expect(userRef.path.map(s => s.prop)).toEqual(["user"])
    })

    it("should create a ref from a nested map value", () => {
      handle.change((d: any) => {
        d.app = { settings: { theme: { color: "blue" } } }
      })

      const doc = handle.doc() as any
      const themeRef = refFromObject(handle, doc.app.settings.theme)

      expect(themeRef.value()).toEqual({ color: "blue" })
      expect(themeRef.path.map(s => s.prop)).toEqual([
        "app",
        "settings",
        "theme",
      ])
    })

    it("should create a ref from a list value", () => {
      handle.change((d: any) => {
        d.items = [
          { title: "First", done: false },
          { title: "Second", done: true },
        ]
      })

      const doc = handle.doc() as any
      const itemsRef = refFromObject(handle, doc.items)

      expect(itemsRef.value()).toEqual([
        { title: "First", done: false },
        { title: "Second", done: true },
      ])
      expect(itemsRef.path.map(s => s.prop)).toEqual(["items"])
    })

    it("should create a ref from an array element", () => {
      handle.change((d: any) => {
        d.todos = [
          { title: "First", done: false },
          { title: "Second", done: true },
        ]
      })

      const doc = handle.doc() as any
      const firstTodoRef = refFromObject(handle, doc.todos[0])

      expect(firstTodoRef.value()).toEqual({ title: "First", done: false })
      expect(firstTodoRef.path.map(s => s.prop)).toEqual(["todos", 0])
    })

    it("should return a ref to the root when given the doc itself", () => {
      handle.change((d: any) => {
        d.value = 42
      })

      const doc = handle.doc() as any
      const rootRef = refFromObject(handle, doc)

      expect(rootRef.path).toEqual([])
      expect(rootRef.value()).toEqual({ value: 42 })
    })

    it("should produce refs whose change() mutates the document", () => {
      handle.change((d: any) => {
        d.user = { name: "Alice", age: 30 }
      })

      const userRef = refFromObject<{ name: string; age: number }>(
        handle,
        (handle.doc() as any).user
      )

      userRef.change(user => {
        user.age = 31
      })

      expect((handle.doc() as any).user).toEqual({ name: "Alice", age: 31 })
    })

    it("should produce refs that are equivalent to handle.ref()", () => {
      handle.change((d: any) => {
        d.todos = [{ title: "First" }, { title: "Second" }]
      })

      const doc = handle.doc() as any
      const fromObject = refFromObject(handle, doc.todos[1])
      const fromPath = handle.ref("todos", 1)

      expect(fromObject.url).toBe(fromPath.url)
      expect(fromObject.isEquivalent(fromPath)).toBe(true)
    })

    it("should throw when called on a primitive", () => {
      handle.change((d: any) => {
        d.count = 42
        d.flag = true
      })

      const doc = handle.doc() as any

      expect(() => refFromObject(handle, doc.count)).toThrow(
        /not an Automerge document sub-object/
      )
      expect(() => refFromObject(handle, doc.flag)).toThrow(
        /not an Automerge document sub-object/
      )
      expect(() => refFromObject(handle, null)).toThrow(
        /not an Automerge document sub-object/
      )
      expect(() => refFromObject(handle, undefined)).toThrow(
        /not an Automerge document sub-object/
      )
    })

    it("should throw when called on a text string value", () => {
      handle.change((d: any) => {
        d.note = "hello world"
      })

      const doc = handle.doc() as any
      expect(() => refFromObject(handle, doc.note)).toThrow(
        /not an Automerge document sub-object/
      )
    })

    it("should throw when called on a plain object not attached to a doc", () => {
      expect(() => refFromObject(handle, { a: 1, b: 2 })).toThrow(
        /not an Automerge document sub-object/
      )
      expect(() => refFromObject(handle, [1, 2, 3])).toThrow(
        /not an Automerge document sub-object/
      )
    })

    it("should throw when the value belongs to a different document", () => {
      handle.change((d: any) => {
        d.user = { name: "Alice" }
      })

      const otherHandle = repo.create()
      otherHandle.change((d: any) => {
        d.user = { name: "Bob" }
      })

      const otherDoc = otherHandle.doc() as any
      expect(() => refFromObject(handle, otherDoc.user)).toThrow(
        /not present in the current document|different document/
      )
    })

    it("should work with objects returned by handle.view()", () => {
      handle.change((d: any) => {
        d.counter = 1
        d.nested = { value: "v1" }
      })

      const heads1 = Automerge.getHeads(handle.doc() as any)
      const encodedHeads1 = encodeHeads(heads1)

      handle.change((d: any) => {
        d.counter = 2
        d.nested.value = "v2"
      })

      const viewHandle = handle.view(encodedHeads1)
      const viewDoc = viewHandle.doc() as any
      const nestedRef = refFromObject(viewHandle, viewDoc.nested)

      expect(nestedRef.value()).toEqual({ value: "v1" })
      expect(nestedRef.path.map(s => s.prop)).toEqual(["nested"])
    })

    it("should be reactive via onChange", () => {
      handle.change((d: any) => {
        d.user = { name: "Alice", age: 30 }
      })

      const userRef = refFromObject<{ name: string; age: number }>(
        handle,
        (handle.doc() as any).user
      )

      const updates: any[] = []
      const unsubscribe = userRef.onChange(value => {
        updates.push(value)
      })

      handle.change((d: any) => {
        d.user.age = 31
      })

      expect(updates).toEqual([{ name: "Alice", age: 31 }])

      unsubscribe()
    })

    it("should preserve identity with other refs to the same path", () => {
      handle.change((d: any) => {
        d.items = [{ v: 1 }, { v: 2 }]
      })

      const doc = handle.doc() as any
      const objectRef = refFromObject(handle, doc.items[0])
      const pathRef = handle.ref("items", 0)

      // Different Ref instances (refFromObject does not go through the cache),
      // but they must be equivalent.
      expect(objectRef.equals(pathRef)).toBe(true)
      expect(objectRef.isEquivalent(pathRef)).toBe(true)
    })

    it("should work with the live proxy inside a change() callback", () => {
      handle.change((d: any) => {
        d.user = { name: "Alice" }
      })

      let capturedPath: (string | number | undefined)[] = []
      handle.change((d: any) => {
        const ref = refFromObject(handle, d.user)
        capturedPath = ref.path.map(s => s.prop)
      })

      expect(capturedPath).toEqual(["user"])
    })

    it("should track the object across a reorder when using index paths", () => {
      handle.change((d: any) => {
        d.todos = [
          { id: "a", title: "First" },
          { id: "b", title: "Second" },
        ]
      })

      const doc = handle.doc() as any
      const ref = refFromObject(handle, doc.todos[1])
      expect(ref.path.map(s => s.prop)).toEqual(["todos", 1])

      // An insert at the front shifts index 1 to index 2. Since refFromObject
      // produced an index-based path, ref.value() now points at a different
      // logical item. This is documented/expected behaviour.
      handle.change((d: any) => {
        d.todos.insertAt(0, { id: "z", title: "Zeroth" })
      })

      expect(ref.value()).toEqual({ id: "a", title: "First" })
    })
  })
})
