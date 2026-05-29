import * as Automerge from "@automerge/automerge"
import { beforeEach, describe, expect, it } from "vitest"
import { Repo } from "../../src/Repo.js"
import type { DocHandle } from "../../src/DocHandle.js"
import { KIND } from "../../src/subdoc-handles/types.js"
import { cursor } from "../../src/subdoc-handles/utils.js"
import { encodeHeads, parseAutomergeUrl } from "../../src/AutomergeUrl.js"
import { splice } from "../../src/index.js"

/**
 * Reconstruct a sub-handle from its URL: parse the URL's segments and
 * apply them via `handle.sub(...)`.
 */
function subFromUrl(h: DocHandle<any>, url: string): DocHandle<any> {
  const parsed = parseAutomergeUrl(url as any)
  if (parsed.documentId !== h.documentId) {
    throw new Error(
      `URL documentId "${parsed.documentId}" does not match handle's documentId "${h.documentId}"`
    )
  }
  const segments = (parsed.segments ?? []) as any[]
  const sub = h.sub(...segments)
  return parsed.heads ? sub.view(parsed.heads) : sub
}

describe("Ref", () => {
  let repo: Repo
  let handle: DocHandle<any>

  beforeEach(() => {
    repo = new Repo()
    handle = repo.create()
  })

  describe("value resolution", () => {
    it("should resolve a simple property path", () => {
      handle.change(d => {
        d.title = "Test Document"
      })

      const ref = handle.sub("title")
      expect(ref.doc()).toBe("Test Document")
    })

    it("should resolve nested paths", () => {
      handle.change(d => {
        d.user = { name: "Alice", age: 30 }
      })

      const nameRef = handle.sub("user", "name")
      expect(nameRef.doc()).toBe("Alice")

      const ageRef = handle.sub("user", "age")
      expect(ageRef.doc()).toBe(30)
    })

    it("should resolve array indices", () => {
      handle.change(d => {
        d.todos = [
          { title: "First", done: false },
          { title: "Second", done: true },
        ]
      })

      const firstTodo = handle.sub("todos", 0)
      expect(firstTodo.doc()).toEqual({ title: "First", done: false })

      const secondTitle = handle.sub("todos", 1, "title")
      expect(secondTitle.doc()).toBe("Second")
    })

    it("should return undefined for invalid paths", () => {
      handle.change(d => {
        d.data = { foo: "bar" }
      })

      const invalidRef = handle.sub("nonexistent", "path")
      expect(invalidRef.doc()).toBeUndefined()
    })

    it("should return undefined for out-of-bounds array access", () => {
      handle.change(d => {
        d.items = ["a", "b", "c"]
      })

      const ref = handle.sub("items", 99)
      expect(ref.doc()).toBeUndefined()
    })
  })

  describe("change", () => {
    it("should mutate objects in place", () => {
      handle.change(d => {
        d.todo = { title: "Buy milk", done: false }
      })

      const doneRef = handle.sub("todo", "done")
      doneRef.change(() => {
        return true
      })

      expect(doneRef.doc()).toBe(true)
    })

    it("should replace primitive values via return", () => {
      handle.change(d => {
        d.counter = 0
      })

      const counterRef = handle.sub("counter")
      counterRef.change((n: any) => n + 1)
      expect(counterRef.doc()).toBe(1)

      counterRef.change((n: any) => n * 2)
      expect(counterRef.doc()).toBe(2)
    })

    it("should replace string values via return", () => {
      handle.change(d => {
        d.greeting = "hello"
      })

      const ref = handle.sub("greeting")
      ref.change((str: any) => str.toUpperCase())
      expect(ref.doc()).toBe("HELLO")
    })

    it("should mutate nested objects", () => {
      handle.change(d => {
        d.user = { name: "Alice", settings: { theme: "light" } }
      })

      const themeRef = handle.sub("user", "settings", "theme")
      themeRef.change(() => "dark")

      expect(themeRef.doc()).toBe("dark")
      expect(handle.doc().user.settings.theme).toBe("dark")
    })

    it("should change a substring using cursor-based range", () => {
      handle.change(d => {
        d.message = "Hello world"
      })

      const rangeRef = handle.sub("message", cursor(0, 5))
      expect(rangeRef.doc()).toBe("Hello")

      rangeRef.change(() => "Hi")

      // The text is replaced at the range
      expect(handle.doc().message).toBe("Hi world")
      // Cursor range collapses after replacement (start and end cursors meet)
      // This is expected behavior - the original "Hello" range was replaced with "Hi"
      // The cursors now point to the same position since the text was replaced
    })

    it("should change a substring using cursor range", () => {
      handle.change(d => {
        d.text = "Hello world"
      })

      // Use cursor() to create cursor-based range
      const rangeRef = handle.sub("text", cursor(0, 5))
      expect(rangeRef.range?.[KIND]).toBe("cursors")
      expect(rangeRef.doc()).toBe("Hello")

      rangeRef.change(() => "Goodbye")

      const doc = handle.doc()
      expect(doc.text).toBe("Goodbye world")
    })

    it("should handle range change in CRDT text", () => {
      handle.change(d => {
        d.note = "Original text"
      })

      // Insert text before the range to test cursor stability
      handle.change(d => {
        splice(d, ["note"], 0, 0, "Prefix: ")
      })

      expect(handle.doc().note).toBe("Prefix: Original text")

      const rangeRef = handle.sub("note", cursor(8, 16))
      expect(rangeRef.doc()).toBe("Original")

      rangeRef.change(() => "Modified")

      expect(handle.doc().note).toBe("Prefix: Modified text")
    })

    it("should replace range with empty string", () => {
      handle.change(d => {
        d.text = "Hello world"
      })

      const rangeRef = handle.sub("text", cursor(6, 11))
      expect(rangeRef.doc()).toBe("world")

      rangeRef.change(() => "")

      expect(handle.doc().text).toBe("Hello ")
    })

    it("should replace range with longer text", () => {
      handle.change(d => {
        d.text = "Hello world"
      })

      const rangeRef = handle.sub("text", cursor(6, 11))
      rangeRef.change(() => "beautiful universe")

      expect(handle.doc().text).toBe("Hello beautiful universe")
    })

    it("should throw when trying to change range on non-string value", () => {
      handle.change(d => {
        d.items = [1, 2, 3]
      })

      // Error is thrown during ref creation, not during change()
      expect(() => {
        handle.sub("items", cursor(0, 2))
      }).toThrow("cursor() can only be used on string values")
    })

    it("should change root document directly", () => {
      handle.change(d => {
        d.counter = 5
      })

      const rootRef = handle.sub()
      rootRef.change((doc: any) => {
        doc.counter = 10
        doc.newField = "added"
      })

      const doc = handle.doc()
      expect(doc.counter).toBe(10)
      expect(doc.newField).toBe("added")
    })
  })

  describe("remove", () => {
    it("should remove a property from an object", () => {
      handle.change(d => {
        d.user = { name: "Alice", age: 30 }
      })

      const ageRef = handle.sub("user", "age")
      expect(ageRef.doc()).toBe(30)

      ageRef.remove()

      expect(handle.doc().user).toEqual({ name: "Alice" })
      expect(handle.doc().user.age).toBeUndefined()
    })

    it("should remove an item from an array", () => {
      handle.change(d => {
        d.todos = [{ title: "First" }, { title: "Second" }, { title: "Third" }]
      })

      const secondRef = handle.sub("todos", 1)
      expect(secondRef.doc()).toEqual({ title: "Second" })

      secondRef.remove()

      expect(handle.doc().todos).toEqual([
        { title: "First" },
        { title: "Third" },
      ])
    })

    it("should remove first item from array", () => {
      handle.change(d => {
        d.items = ["a", "b", "c"]
      })

      const firstRef = handle.sub("items", 0)
      firstRef.remove()

      expect(handle.doc().items).toEqual(["b", "c"])
    })

    it("should remove last item from array", () => {
      handle.change(d => {
        d.items = ["a", "b", "c"]
      })

      const lastRef = handle.sub("items", 2)
      lastRef.remove()

      expect(handle.doc().items).toEqual(["a", "b"])
    })

    it("should remove nested property", () => {
      handle.change(d => {
        d.config = {
          settings: {
            theme: "dark",
            fontSize: 14,
          },
        }
      })

      const themeRef = handle.sub("config", "settings", "theme")
      themeRef.remove()

      expect(handle.doc().config.settings).toEqual({ fontSize: 14 })
    })

    it("should remove item from nested array", () => {
      handle.change(d => {
        d.board = {
          columns: [{ name: "Todo" }, { name: "Done" }],
        }
      })

      const columnRef = handle.sub("board", "columns", 0)
      columnRef.remove()

      expect(handle.doc().board.columns).toEqual([{ name: "Done" }])
    })

    it("should throw when removing root document", () => {
      const rootRef = handle.sub()

      expect(() => rootRef.remove()).toThrow("Cannot remove the root document")
    })

    it("should throw when removing from a ref pinned to heads", () => {
      handle.change(d => {
        d.value = 42
      })

      // Get heads and create a read-only view handle
      const heads = handle.heads()
      const viewHandle = handle.view(heads)
      const pinnedRef = viewHandle.sub("value")

      expect(() => pinnedRef.remove()).toThrow("Cannot remove on")
    })

    it("should remove text within a range", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      const rangeRef = handle.sub("text", cursor(0, 5))
      expect(rangeRef.doc()).toBe("Hello")

      rangeRef.remove()

      expect(handle.doc().text).toBe(" World")
    })

    it("should remove text at end of string", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      const rangeRef = handle.sub("text", cursor(6, 11))
      expect(rangeRef.doc()).toBe("World")

      rangeRef.remove()

      expect(handle.doc().text).toBe("Hello ")
    })

    it("should remove text in middle of string", () => {
      handle.change(d => {
        d.text = "Hello Beautiful World"
      })

      const rangeRef = handle.sub("text", cursor(6, 16))
      expect(rangeRef.doc()).toBe("Beautiful ")

      rangeRef.remove()

      expect(handle.doc().text).toBe("Hello World")
    })

    it("should remove item matched by pattern", () => {
      handle.change(d => {
        d.users = [
          { id: "a", name: "Alice" },
          { id: "b", name: "Bob" },
          { id: "c", name: "Charlie" },
        ]
      })

      const bobRef = handle.sub("users", { id: "b" })
      bobRef.remove()

      expect(handle.doc().users).toEqual([
        { id: "a", name: "Alice" },
        { id: "c", name: "Charlie" },
      ])
    })

    it("should remove top-level key from document", () => {
      handle.change(d => {
        d.name = "Test"
        d.value = 42
      })

      const nameRef = handle.sub("name")
      nameRef.remove()

      expect(handle.doc().name).toBeUndefined()
      expect(handle.doc().value).toBe(42)
    })
  })

  describe("url generation", () => {
    it("should generate a basic URL", () => {
      handle.change(d => {
        d.title = "Test"
      })

      const ref = handle.sub("title")
      const url = ref.url

      expect(url).toContain("automerge:")
      expect(url).toContain(handle.documentId)
      expect(url).toContain("title")
    })

    it("should include nested paths in URL", () => {
      const ref = handle.sub("user", "name")
      const url = ref.url

      expect(url).toContain("user")
      expect(url).toContain("name")
    })

    it("should format simple property path", () => {
      const ref = handle.sub("counter")
      const url = ref.url

      expect(url).toBe(`automerge:${handle.documentId}/counter`)
    })

    it("should format nested property paths with slashes", () => {
      const ref = handle.sub("user", "profile", "name")
      const url = ref.url

      expect(url).toBe(`automerge:${handle.documentId}/user/profile/name`)
    })

    it("should format numeric indices with @ prefix", () => {
      handle.change(d => {
        d.items = ["a", "b", "c"]
      })

      const ref = handle.sub("items", 1)
      const url = ref.url

      // Numeric index should use @n format
      expect(url).toBe(`automerge:${handle.documentId}/items/@1`)
    })

    it("should format numeric indices in URL", () => {
      handle.change(d => {
        d.todos = [{ title: "First" }, { title: "Second" }]
      })

      const ref = handle.sub("todos", 0)
      const url = ref.url

      // Should have @n format for index
      expect(url).toBe(`automerge:${handle.documentId}/todos/@0`)
    })

    it("should format deep paths with numeric indices", () => {
      handle.change(d => {
        d.boards = [
          {
            columns: [{ name: "Todo" }, { name: "Done" }],
          },
        ]
      })

      const ref = handle.sub("boards", 0, "columns", 1, "name")
      const url = ref.url

      // Should have @n format for array indices
      expect(url).toBe(
        `automerge:${handle.documentId}/boards/@0/columns/@1/name`
      )
    })

    it("should format cursor ranges with bracket notation", () => {
      handle.change(d => {
        d.note = "Hello World"
      })

      const ref = handle.sub("note", cursor(0, 5))
      const url = ref.url

      // Cursor range should use [start-end] bracket format
      // Cursors have format: number@hash
      expect(url).toMatch(
        /^automerge:[^/]+\/note\/\[\d+@[a-f0-9]+-\d+@[a-f0-9]+\]$/
      )
      expect(url).toContain("[") // Bracket notation
    })

    it("should format match clauses as URL-encoded JSON", () => {
      handle.change(d => {
        d.items = [{ id: "a" }, { id: "b" }]
      })

      const ref = handle.sub("items", { id: "b" })
      const url = ref.url

      // Match clause should be URL-encoded JSON to protect special characters
      expect(url).toBe(
        `automerge:${handle.documentId}/items/${encodeURIComponent(
          '{"id":"b"}'
        )}`
      )
    })

    it("should handle complex nested structures", () => {
      handle.change(d => {
        d.app = {
          users: [
            {
              id: "user1",
              posts: [{ title: "Post 1" }, { title: "Post 2" }],
            },
          ],
        }
      })

      const ref = handle.sub("app", "users", 0, "posts", 1, "title")
      const url = ref.url

      // Should have proper ObjectId formatting
      expect(url).toContain("automerge:")
      expect(url).toContain("/app/users/")
      expect(url).toContain("/posts/")
      expect(url).toContain("/title")
      expect(url).toMatch(/:[a-zA-Z0-9]+/) // Should have ObjectIds
    })

    it("should generate consistent URLs for same path", () => {
      handle.change(d => {
        d.todos = [{ title: "Task" }]
      })

      const ref1 = handle.sub("todos", 0)
      const ref2 = handle.sub("todos", 0)

      expect(ref1.url).toBe(ref2.url)
    })

    it("should generate different URLs for different paths", () => {
      handle.change(d => {
        d.todos = [{ title: "A" }, { title: "B" }]
      })

      const ref1 = handle.sub("todos", 0)
      const ref2 = handle.sub("todos", 1)

      expect(ref1.url).not.toBe(ref2.url)
    })

    it("should handle text range in nested path", () => {
      handle.change(d => {
        d.docs = [{ content: "Hello World" }]
      })

      const ref = handle.sub("docs", 0, "content", cursor(0, 5))
      const url = ref.url

      // Should have @n for index and [cursor-cursor] for range
      expect(url).toMatch(
        /^automerge:[^/]+\/docs\/@0\/content\/\[\d+@[a-f0-9]+-\d+@[a-f0-9]+\]$/
      )
    })

    it("should use @n format for indices in URL", () => {
      handle.change(d => {
        d.items = [{ name: "A" }, { name: "B" }]
      })

      const ref = handle.sub("items", 0)

      // Should use @n format for index
      expect(ref.url).toBe(`automerge:${handle.documentId}/items/@0`)
    })

    it("should handle primitives in arrays", () => {
      handle.change(d => {
        d.numbers = [1, 2, 3]
      })

      const ref = handle.sub("numbers", 1)
      const url = ref.url

      // Should use @n format for index
      expect(url).toBe(`automerge:${handle.documentId}/numbers/@1`)
    })
  })

  describe("idempotency", () => {
    it("should produce identical paths when parsing URL twice", () => {
      handle.change(d => {
        d.todos = [{ title: "First" }, { title: "Second" }]
      })

      // Create ref and serialize to URL
      const ref1 = handle.sub("todos", 0, "title")
      const url = ref1.url

      // Parse URL and create new ref
      const ref2 = subFromUrl(handle, url)

      // Both refs should have identical URLs
      expect(ref2.url).toBe(ref1.url)
      expect(ref2.doc()).toBe(ref1.doc())

      expect(ref2.equals(ref1)).toBe(true)
    })

    it("should preserve cursor ranges through URL round-trip", () => {
      handle.change(d => {
        d.note = "Hello World"
      })

      // Create ref with cursor range
      const ref1 = handle.sub("note", cursor(0, 5))
      const url = ref1.url

      // Parse from URL
      const ref2 = subFromUrl(handle, url)

      // Should have same cursor range
      expect(ref2.url).toBe(ref1.url)
      expect(ref2.doc()).toBe("Hello")

      // Insert text before the range
      handle.change(d => {
        splice(d, ["note"], 0, 0, "XXX")
      })

      // Both refs should still resolve correctly (cursors are stable)
      expect(ref1.doc()).toBe("Hello")
      expect(ref2.doc()).toBe("Hello")
    })

    it("should handle multiple subFromUrl round-trips without drift", () => {
      handle.change(d => {
        d.data = [{ value: 42 }]
      })

      const ref1 = handle.sub("data", 0, "value")

      // Round-trip 1
      const url1 = ref1.url
      const ref2 = subFromUrl(handle, url1)

      // Round-trip 2
      const url2 = ref2.url
      const ref3 = subFromUrl(handle, url2)

      // Round-trip 3
      const url3 = ref3.url
      const ref4 = subFromUrl(handle, url3)

      // All URLs should be identical (this is the key invariant)
      expect(url1).toBe(url2)
      expect(url2).toBe(url3)

      // All refs should resolve to the same value
      expect(ref1.doc()).toBe(42)
      expect(ref2.doc()).toBe(42)
      expect(ref3.doc()).toBe(42)
      expect(ref4.doc()).toBe(42)

      // All refs should be equal (same URL)
      expect(ref2.equals(ref1)).toBe(true)
      expect(ref3.equals(ref1)).toBe(true)
      expect(ref4.equals(ref1)).toBe(true)
    })

    it("should throw when URL documentId does not match handle", () => {
      // Create a second handle with a different documentId
      const handle2 = repo.create()

      // Get URL from first handle
      const ref1 = handle.sub("value")
      const url = ref1.url

      // Trying to use subFromUrl with a different handle should throw
      expect(() => subFromUrl(handle2, url)).toThrow(
        /URL documentId .* does not match handle's documentId/
      )
    })
  })

  describe("equality", () => {
    it("should consider refs equal if they have the same URL", () => {
      handle.change(d => {
        d.todos = [{ title: "A" }, { title: "B" }]
      })

      const ref1 = handle.sub("todos", 0)
      const ref2 = handle.sub("todos", 0)

      expect(ref1.equals(ref2)).toBe(true)
      expect(ref1.url).toBe(ref2.url)
    })

    it("should consider refs unequal if paths differ", () => {
      handle.change(d => {
        d.todos = [{ title: "A" }, { title: "B" }]
      })

      const ref1 = handle.sub("todos", 0)
      const ref2 = handle.sub("todos", 1)

      expect(ref1.equals(ref2)).toBe(false)
    })

    it("should support valueOf for == comparison", () => {
      const ref1 = handle.sub("title")
      const ref2 = handle.sub("title")

      expect(ref1.valueOf()).toBe(ref2.valueOf())
    })
  })

  describe("doc access", () => {
    it("should return the current document", () => {
      handle.change(d => {
        d.title = "Test"
      })

      const ref = handle.sub("title")
      const doc = ref.fullDoc()

      expect(doc).toBeDefined()
      expect(doc?.title).toBe("Test")
    })
  })

  describe("where clause resolution", () => {
    it("should find items by where clause", () => {
      handle.change(d => {
        d.todos = [
          { id: "a", title: "First" },
          { id: "b", title: "Second" },
          { id: "c", title: "Third" },
        ]
      })

      const ref = handle.sub("todos", { id: "b" })
      expect(ref.doc()).toEqual({ id: "b", title: "Second" })
    })

    it("should return undefined if no match found", () => {
      handle.change(d => {
        d.todos = [{ id: "a", title: "First" }]
      })

      const ref = handle.sub("todos", { id: "nonexistent" })
      expect(ref.doc()).toBeUndefined()
    })

    it("should match multiple fields in where clause", () => {
      handle.change(d => {
        d.items = [
          { type: "task", status: "done", title: "A" },
          { type: "task", status: "pending", title: "B" },
          { type: "note", status: "done", title: "C" },
        ]
      })

      const ref = handle.sub("items", { type: "task", status: "done" })
      expect(ref.doc()).toEqual({ type: "task", status: "done", title: "A" })
    })
  })

  describe("ref behavior", () => {
    it("should resolve numeric indices positionally", () => {
      handle.change(d => {
        d.todos = [{ title: "A" }, { title: "B" }, { title: "C" }]
      })

      const ref = (handle as DocHandle<Todo>).sub("todos", 1)
      type Todo = {
        todos: Array<{
          title: string
        }>
      }

      expect(ref.doc()?.title).toBe("B")
    })

    it("should track position changes for numeric indices", () => {
      handle.change(d => {
        d.todos = [{ title: "A" }, { title: "B" }, { title: "C" }]
      })

      // Create ref to position 1
      const ref = handle.sub("todos", 1, "title")
      expect(ref.doc()).toBe("B")

      // Remove first item - position 1 now has "C"
      handle.change(d => {
        d.todos.deleteAt(0)
      })

      // Numeric ref now points to position 1 (which is "C")
      expect(ref.doc()).toBe("C")
    })

    it("should use match patterns to find items", () => {
      handle.change(d => {
        d.items = [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
        ]
      })

      // Match clause finds item by properties
      const ref = handle.sub("items", { id: "b" }, "value")

      expect(ref.doc()).toBe(2)

      // Path should contain match pattern
      expect(ref.path[1][KIND]).toBe("match")
      expect((ref.path[1] as any).match).toEqual({ id: "b" })
    })

    it("should keep match refs stable after reordering", () => {
      handle.change(d => {
        d.items = [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
          { id: "c", value: 3 },
        ]
      })

      // Match clause finds item by id pattern
      const ref = handle.sub("items", { id: "b" }, "value")
      expect(ref.doc()).toBe(2)

      // Move "b" to a different position by deleting first item
      handle.change(d => {
        d.items.deleteAt(0) // Remove "a", now "b" is at index 0
      })

      // Should still resolve to item with id "b" (now at index 0)
      expect(ref.doc()).toBe(2)
    })

    it("should use numeric indices for primitives", () => {
      handle.change(d => {
        d.numbers = [1, 2, 3]
      })

      const ref = handle.sub("numbers", 1)
      expect(ref.path[0][KIND]).toBe("key")
      expect((ref.path[0] as any).key).toBe("numbers")
      expect(ref.path[1][KIND]).toBe("index")
      expect((ref.path[1] as any).index).toBe(1)
      expect(ref.doc()).toBe(2)
    })

    it("should create cursor-based ranges with cursor()", () => {
      handle.change(d => {
        d.note = "Hello World"
      })

      // Use cursor() to create cursor-based range
      const ref = handle.sub("note", cursor(0, 5))

      // Range should be cursor-based
      expect(ref.range?.[KIND]).toBe("cursors")
      expect(typeof ref.range?.start).toBe("string") // Cursor
      expect(typeof ref.range?.end).toBe("string") // Cursor

      expect(ref.doc()).toBe("Hello")
    })

    it("should track cursor ranges through text edits", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      // Create cursor-based range
      const cursorRef = handle.sub("text", cursor(0, 5))
      expect(cursorRef.range?.[KIND]).toBe("cursors")
      expect(cursorRef.doc()).toBe("Hello")

      // Insert at beginning
      handle.change(d => {
        splice(d, ["text"], 0, 0, ">> ")
      })

      // Cursor range tracks the original text (now "Hello")
      expect(cursorRef.doc()).toBe("Hello")
    })
  })

  describe("change callback behavior", () => {
    it("should pass current value to callback", () => {
      handle.change(d => {
        d.counter = 5
      })

      const ref = handle.sub("counter")

      let receivedValue: number | undefined
      ref.change((val: any) => {
        receivedValue = val
      })

      expect(receivedValue).toBe(5)
    })

    it("should not update if callback returns void", () => {
      handle.change(d => {
        d.data = { value: 10 }
      })

      const ref = handle.sub("data", "value")

      ref.change(() => {
        // Return void - no update
      })

      expect(ref.doc()).toBe(10)
    })

    it("should update when callback returns a value", () => {
      handle.change(d => {
        d.counter = 0
      })

      const ref = handle.sub("counter")

      ref.change((val: any) => val + 10)
      expect(ref.doc()).toBe(10)

      ref.change((val: any) => val * 2)
      expect(ref.doc()).toBe(20)
    })

    it("should allow mutations on objects", () => {
      handle.change(d => {
        d.config = { enabled: false, count: 0 }
      })

      const ref = handle.sub("config")

      ref.change((config: any) => {
        config.enabled = true
        config.count = 5
        // Return void - mutations applied
      })

      expect(ref.doc()).toEqual({ enabled: true, count: 5 })
    })

    it("should allow replacing entire objects via the shorthand value form", () => {
      handle.change(d => {
        d.settings = { theme: "light" }
      })

      const ref = handle.sub("settings")

      // The shorthand (non-function) form is the explicit way to overwrite a
      // slot. A function callback that returns an object is ignored (mutate in
      // place instead), consistent with root `change()`.
      ref.change({ theme: "dark", fontSize: 14 } as any)

      expect(ref.doc()).toEqual({ theme: "dark", fontSize: 14 })
    })

    it("should work with nested paths", () => {
      handle.change(d => {
        d.user = {
          profile: {
            name: "Alice",
            age: 25,
          },
        }
      })

      const ageRef = handle.sub("user", "profile", "age")

      ageRef.change((age: any) => age + 1)
      expect(ageRef.doc()).toBe(26)
      expect(handle.doc().user.profile.age).toBe(26)
    })

    it("should handle undefined values gracefully", () => {
      handle.change(d => {
        d.data = {}
      })

      const ref = handle.sub("data", "missing")

      let receivedValue: any
      ref.change((val: any) => {
        receivedValue = val
        return "now exists"
      })

      expect(receivedValue).toBeUndefined()
      expect(ref.doc()).toBe("now exists")
    })

    it("should allow conditional updates", () => {
      type Counter = {
        counter: number
      }
      handle.change(d => {
        d.counter = 5
      })

      const ref = (handle as DocHandle<Counter>).sub("counter")

      // Only update if > 10
      ref.change(val => {
        if (val > 10) return 0
        // return 0
        // Return undefined = no change
      })

      expect(ref.doc()).toBe(5)

      // Update to trigger condition
      ref.change(() => 15)
      ref.change(val => {
        if (val > 10) return 0
      })

      expect(ref.doc()).toBe(0)
    })
  })

  describe("on('change') event listening", () => {
    it("should fire when the referenced value changes", async () => {
      handle.change(d => {
        d.counter = 0
      })

      const ref = handle.sub("counter")

      const changePromise = new Promise<void>(resolve => {
        ref.onChange(() => {
          expect(ref.doc()).toBe(1)
          resolve()
        })
      })

      handle.change(d => {
        d.counter = 1
      })

      await changePromise
    })

    it("should NOT fire when unrelated values change", async () => {
      handle.change(d => {
        d.counter = 0
        d.other = "initial"
      })

      const ref = handle.sub("counter")
      let callCount = 0

      ref.onChange(() => {
        callCount++
      })

      // Change unrelated value
      handle.change(d => {
        d.other = "changed"
      })

      // Wait a bit and verify callback wasn't called
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(0)
    })

    it("should fire when nested value changes", async () => {
      handle.change(d => {
        d.user = { profile: { name: "Alice" } }
      })

      const nameRef = handle.sub("user", "profile", "name")

      const changePromise = new Promise<void>(resolve => {
        nameRef.onChange(() => {
          expect(nameRef.doc()).toBe("Bob")
          resolve()
        })
      })

      handle.change(d => {
        d.user.profile.name = "Bob"
      })

      await changePromise
    })

    it("should NOT fire when parent's sibling changes", async () => {
      handle.change(d => {
        d.user = { profile: { name: "Alice", age: 30 } }
      })

      const nameRef = handle.sub("user", "profile", "name")
      let callCount = 0

      nameRef.onChange(() => {
        callCount++
      })

      // Change sibling property
      handle.change(d => {
        d.user.profile.age = 31
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(0)
    })

    it("should fire for array element changes with ObjectId refs", async () => {
      handle.change(d => {
        d.todos = [
          { title: "First", done: false },
          { title: "Second", done: false },
        ]
      })

      // This ref will be stabilized to ObjectId
      const todoRef = (handle as DocHandle<Todo>).sub("todos", 0)
      type Todo = {
        todos: Array<{
          title: string
          done: boolean
        }>
      }

      const changePromise = new Promise<void>(resolve => {
        todoRef.onChange(() => {
          expect(todoRef.doc()?.done).toBe(true)
          resolve()
        })
      })

      handle.change(d => {
        d.todos[0].done = true
      })

      await changePromise
    })

    it("should fire for refs at the correct position", async () => {
      handle.change(d => {
        d.items = ["a", "b", "c"]
      })

      const ref = handle.sub("items", 1)

      const changePromise = new Promise<void>(resolve => {
        ref.onChange(() => {
          expect(ref.doc()).toBe("modified")
          resolve()
        })
      })

      // Change position 1
      handle.change(d => {
        d.items[1] = "modified"
      })

      await changePromise
    })

    it("should provide patches in callback, scoped relative to the ref", async () => {
      handle.change(d => {
        d.data = { value: 10 }
      })

      // Scope to the `data` object; a change to `data.value` is *inside*
      // the scope and should arrive as a patch with a path relative to the
      // ref (`["value"]`, not `["data", "value"]`).
      const ref = handle.sub("data")

      const changePromise = new Promise<void>(resolve => {
        ref.onChange((value, { patches, scopeReplaced }) => {
          expect(scopeReplaced).toBe(false)
          expect(Array.isArray(patches)).toBe(true)
          expect(patches.length).toBeGreaterThan(0)
          expect(patches[0].path).toEqual(["value"])
          resolve()
        })
      })

      handle.change(d => {
        d.data.value = 20
      })

      await changePromise
    })

    it("should signal scopeReplaced when the ref's own value is replaced", async () => {
      handle.change(d => {
        d.data = { value: 10 }
      })

      // Scope to a leaf primitive; setting it is a change *at* the scope
      // boundary, reported via `scopeReplaced` with the new value on `doc`.
      const ref = handle.sub("data", "value")

      const changePromise = new Promise<void>(resolve => {
        ref.onChange((value, { patches, scopeReplaced, doc }) => {
          expect(scopeReplaced).toBe(true)
          expect(patches).toEqual([])
          expect(doc).toBe(20)
          expect(value).toBe(20)
          resolve()
        })
      })

      handle.change(d => {
        d.data.value = 20
      })

      await changePromise
    })

    it("should allow unsubscribing from changes", async () => {
      handle.change(d => {
        d.counter = 0
      })

      const ref = handle.sub("counter")
      let callCount = 0

      const unsubscribe = ref.onChange(() => {
        callCount++
      })

      // Make one change
      handle.change(d => {
        d.counter = 1
      })

      // Wait for the change to propagate
      await new Promise(resolve => setTimeout(resolve, 10))

      // Unsubscribe
      unsubscribe()

      // Make another change
      handle.change(d => {
        d.counter = 2
      })

      // Verify only the first change was detected
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1)
    })

    it("should fire for text range changes", async () => {
      handle.change(d => {
        d.note = "Hello World"
      })

      const rangeRef = handle.sub("note", cursor(0, 5))

      const changePromise = new Promise<void>(resolve => {
        rangeRef.onChange(() => {
          // Cursor range tracks original text
          expect(rangeRef.doc()).toBe("Hello")
          resolve()
        })
      })

      // Insert text before the range
      handle.change(d => {
        splice(d, ["note"], 0, 0, ">>> ")
      })

      await changePromise
    })

    it("should fire for where clause refs when matched item changes", async () => {
      handle.change(d => {
        d.items = [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
        ]
      })

      // Where clause will be stabilized to ObjectId
      const ref = handle.sub("items", { id: "b" }, "value")

      const changePromise = new Promise<void>(resolve => {
        ref.onChange(() => {
          expect(ref.doc()).toBe(20)
          resolve()
        })
      })

      handle.change(d => {
        d.items[1].value = 20
      })

      await changePromise
    })
  })

  describe("on('change') event filtering - subtree changes", () => {
    it("should fire when direct child changes", async () => {
      handle.change(d => {
        d.user = { name: "Alice", age: 30, address: { city: "NYC" } }
      })

      const userRef = handle.sub("user")
      let callCount = 0

      userRef.onChange(() => {
        callCount++
      })

      // Change direct child property
      handle.change(d => {
        d.user.name = "Bob"
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1)
    })

    it("should fire when deeply nested descendant changes", async () => {
      handle.change(d => {
        d.user = {
          profile: {
            personal: {
              contact: {
                email: "alice@example.com",
              },
            },
          },
        }
      })

      const userRef = handle.sub("user")
      let callCount = 0

      userRef.onChange(() => {
        callCount++
      })

      // Change deeply nested property
      handle.change(d => {
        d.user.profile.personal.contact.email = "bob@example.com"
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1)
    })

    it("should NOT fire when sibling property changes", async () => {
      handle.change(d => {
        d.data = {
          settings: { theme: "light" },
          preferences: { lang: "en" },
        }
      })

      const settingsRef = handle.sub("data", "settings")
      let callCount = 0

      settingsRef.onChange(() => {
        callCount++
      })

      // Change sibling property
      handle.change(d => {
        d.data.preferences.lang = "fr"
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(0)
    })

    it("should fire when parent changes (replaces subtree)", async () => {
      handle.change(d => {
        d.user = { profile: { name: "Alice" } }
      })

      const nameRef = handle.sub("user", "profile", "name")
      let callCount = 0

      nameRef.onChange(() => {
        callCount++
      })

      // Replace parent object
      handle.change(d => {
        d.user.profile = { name: "Bob" }
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1)
    })

    it("should fire for multiple changes in subtree", async () => {
      handle.change(d => {
        d.user = { name: "Alice", age: 30, email: "alice@example.com" }
      })

      const userRef = handle.sub("user")
      let callCount = 0

      userRef.onChange(() => {
        callCount++
      })

      // Change multiple properties in subtree
      handle.change(d => {
        d.user.name = "Bob"
        d.user.age = 31
        d.user.email = "bob@example.com"
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      // Should fire once per change batch
      expect(callCount).toBe(1)
    })

    it("should maintain filtering after document changes", async () => {
      handle.change(d => {
        d.config = { theme: "light", lang: "en" }
        d.other = "value"
      })

      const themeRef = handle.sub("config", "theme")
      let callCount = 0

      themeRef.onChange(() => {
        callCount++
      })

      // Make several changes, only some affect the ref
      handle.change(d => {
        d.config.theme = "dark" // Should fire
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1)

      handle.change(d => {
        d.other = "changed" // Should NOT fire
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1) // Still 1

      handle.change(d => {
        d.config.lang = "fr" // Should NOT fire (sibling)
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1) // Still 1

      handle.change(d => {
        d.config.theme = "blue" // Should fire
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(2) // Now 2
    })

    it("should fire for array element in subtree", async () => {
      handle.change(d => {
        d.data = {
          items: [
            { id: 1, name: "A" },
            { id: 2, name: "B" },
          ],
          meta: { count: 2 },
        }
      })

      const dataRef = handle.sub("data")
      let callCount = 0

      dataRef.onChange(() => {
        callCount++
      })

      // Change array element (part of subtree)
      handle.change(d => {
        d.data.items[0].name = "AA"
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1)
    })

    it("should NOT fire when unrelated array changes", async () => {
      handle.change(d => {
        d.todos = [{ title: "A" }, { title: "B" }]
        d.notes = [{ content: "X" }, { content: "Y" }]
      })

      const todosRef = handle.sub("todos")
      let callCount = 0

      todosRef.onChange(() => {
        callCount++
      })

      // Change unrelated array
      handle.change(d => {
        d.notes[0].content = "XX"
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(0)
    })

    it("should fire when adding property to object in subtree", async () => {
      handle.change(d => {
        d.config = { theme: "light" }
      })

      const configRef = handle.sub("config")
      let callCount = 0

      configRef.onChange(() => {
        callCount++
      })

      // Add new property
      handle.change(d => {
        d.config.fontSize = 14
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1)
    })

    it("should fire when deleting property in subtree", async () => {
      handle.change(d => {
        d.user = { name: "Alice", age: 30, temp: "data" }
      })

      const userRef = handle.sub("user")
      let callCount = 0

      userRef.onChange(() => {
        callCount++
      })

      // Delete property
      handle.change(d => {
        delete d.user.temp
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1)
    })

    it("should work with stabilized ObjectId refs", async () => {
      handle.change(d => {
        d.items = [
          { id: "a", value: 1, meta: { tag: "x" } },
          { id: "b", value: 2, meta: { tag: "y" } },
        ]
      })

      // Create ref with stabilized ObjectId (will auto-stabilize)
      const itemRef = handle.sub("items", 0)
      let callCount = 0

      itemRef.onChange(() => {
        callCount++
      })

      // Change property in the referenced item
      handle.change(d => {
        d.items[0].value = 100
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1)

      // Change different item (should NOT fire)
      handle.change(d => {
        d.items[1].value = 200
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1) // Still 1
    })

    it("should work with deep paths and ObjectIds", async () => {
      handle.change(d => {
        d.boards = [
          {
            id: "board1",
            columns: [
              { name: "Todo", count: 5 },
              { name: "Done", count: 3 },
            ],
          },
        ]
      })

      // Deep ref with auto-stabilized ObjectId
      const columnRef = handle.sub("boards", 0, "columns", 1)
      let callCount = 0

      columnRef.onChange(() => {
        callCount++
      })

      // Change the referenced column
      handle.change(d => {
        d.boards[0].columns[1].count = 4
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1)

      // Change different column (should NOT fire)
      handle.change(d => {
        d.boards[0].columns[0].count = 6
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(1) // Still 1

      // Replace the entire columns array (parent, should fire)
      handle.change(d => {
        d.boards[0].columns = [
          { name: "Todo", count: 6 },
          { name: "Done", count: 4 },
        ]
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(callCount).toBe(2) // Now 2
    })
  })

  describe("viewAt", () => {
    it("should create a new ref with different heads", () => {
      handle.change(d => {
        d.value = 1
      })
      const heads1 = Automerge.getHeads(handle.doc())

      handle.change(d => {
        d.value = 2
      })

      const currentRef = handle.sub("value")
      expect(currentRef.doc()).toBe(2)

      const pastRef = currentRef.view(encodeHeads(heads1))
      expect(pastRef.doc()).toBe(1)

      // Original ref should be unchanged
      expect(currentRef.doc()).toBe(2)
    })

    it("should work with nested paths", () => {
      handle.change(d => {
        d.user = { name: "Alice" }
      })
      const heads1 = Automerge.getHeads(handle.doc())

      handle.change(d => {
        d.user.name = "Bob"
      })

      const currentRef = handle.sub("user", "name")
      expect(currentRef.doc()).toBe("Bob")

      const pastRef = currentRef.view(encodeHeads(heads1))
      expect(pastRef.doc()).toBe("Alice")
    })

    it("should return new Ref instance", () => {
      handle.change(d => {
        d.value = 1
      })
      const heads = Automerge.getHeads(handle.doc())

      const currentRef = handle.sub("value")
      const pastRef = currentRef.view(encodeHeads(heads))

      // The view-pinned ref is a different handle from the live one.
      expect(pastRef).not.toBe(currentRef)
      // Both live in the same document, so `.docHandle` points at the
      // same root - unification means there's one shared root handle.
      expect(pastRef.docHandle).toBe(currentRef.docHandle)
      expect(pastRef.docHandle.documentId).toBe(currentRef.docHandle.documentId)
    })

    it("should preserve path", () => {
      handle.change(d => {
        d.nested = { deep: { value: 42 } }
      })
      const heads = Automerge.getHeads(handle.doc())

      const originalRef = handle.sub("nested", "deep", "value")
      const viewRef = originalRef.view(encodeHeads(heads))

      expect(viewRef.path).toEqual(originalRef.path)
    })

    it("should not allow changes on time-travel refs", () => {
      handle.change(d => {
        d.value = 1
      })
      const heads1 = Automerge.getHeads(handle.doc())

      const pastRef = handle.sub("value").view(encodeHeads(heads1))

      expect(() => {
        pastRef.change(() => 2)
      }).toThrow("Cannot change on")
    })
  })

  describe("contains", () => {
    it("should return true when ref contains another ref", () => {
      handle.change(d => {
        d.todos = [{ title: "Task", done: false }]
      })

      const todoRef = handle.sub("todos", 0)
      const titleRef = handle.sub("todos", 0, "title")

      expect(todoRef.contains(titleRef)).toBe(true)
    })

    it("should return false when ref does not contain another", () => {
      handle.change(d => {
        d.todos = [{ title: "Task", done: false }]
      })

      const titleRef = handle.sub("todos", 0, "title")
      const todoRef = handle.sub("todos", 0)

      expect(titleRef.contains(todoRef)).toBe(false)
    })

    it("should return false for refs with same length path", () => {
      handle.change(d => {
        d.user = { name: "Alice", email: "alice@example.com" }
      })

      const nameRef = handle.sub("user", "name")
      const emailRef = handle.sub("user", "email")

      expect(nameRef.contains(emailRef)).toBe(false)
      expect(emailRef.contains(nameRef)).toBe(false)
    })

    it("should return false for different documents", () => {
      const handle2 = repo.create()
      handle.change(d => {
        d.value = 1
      })
      handle2.change((d: any) => {
        d.value = 1
      })

      const ref1 = handle.sub("value")
      const ref2 = handle2.sub("value")

      expect(ref1.contains(ref2)).toBe(false)
    })

    it("should return false for different heads", () => {
      handle.change(d => {
        d.value = 1
      })
      const heads1 = Automerge.getHeads(handle.doc())

      handle.change(d => {
        d.value = 2
      })
      const heads2 = Automerge.getHeads(handle.doc())

      const ref1 = handle.sub("value").view(encodeHeads(heads1))
      const ref2 = handle.sub("value").view(encodeHeads(heads2))

      expect(ref1.contains(ref2)).toBe(false)
    })

    it("should work with stable refs (ObjectIds)", () => {
      handle.change(d => {
        d.items = [{ value: 1 }, { value: 2 }]
      })

      const itemRef = handle.sub("items", 0) // Will stabilize
      const valueRef = handle.sub("items", 0, "value")

      expect(itemRef.contains(valueRef)).toBe(true)
    })

    it("should work with id patterns", () => {
      handle.change(d => {
        d.users = [{ id: "alice", name: "Alice" }]
      })

      const userRef = handle.sub("users", { id: "alice" })
      const nameRef = handle.sub("users", { id: "alice" }, "name")

      expect(userRef.contains(nameRef)).toBe(true)
    })

    it("should return true for root containing any path", () => {
      handle.change(d => {
        d.nested = { deep: { value: 42 } }
      })

      const rootRef = handle.sub()
      const deepRef = handle.sub("nested", "deep", "value")

      expect(rootRef.contains(deepRef)).toBe(true)
    })
  })

  describe("overlaps", () => {
    it("should return true for overlapping ranges", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      const range1 = handle.sub("text", cursor(0, 5))
      const range2 = handle.sub("text", cursor(3, 8))

      expect(range1.overlaps(range2)).toBe(true)
      expect(range2.overlaps(range1)).toBe(true)
    })

    it("should return false for non-overlapping ranges", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      const range1 = handle.sub("text", cursor(0, 5))
      const range2 = handle.sub("text", cursor(6, 11))

      expect(range1.overlaps(range2)).toBe(false)
      expect(range2.overlaps(range1)).toBe(false)
    })

    it("should return false for adjacent ranges that touch", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      const range1 = handle.sub("text", cursor(0, 5))
      const range2 = handle.sub("text", cursor(5, 10))

      expect(range1.overlaps(range2)).toBe(false)
    })

    it("should return true when one range contains another", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      const range1 = handle.sub("text", cursor(0, 10))
      const range2 = handle.sub("text", cursor(3, 7))

      expect(range1.overlaps(range2)).toBe(true)
      expect(range2.overlaps(range1)).toBe(true)
    })

    it("should return false for refs without ranges", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      const ref1 = handle.sub("text")
      const ref2 = handle.sub("text")

      expect(ref1.overlaps(ref2)).toBe(false)
    })

    it("should return false when only one ref has a range", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      const textRef = handle.sub("text")
      const rangeRef = handle.sub("text", cursor(0, 5))

      expect(textRef.overlaps(rangeRef)).toBe(false)
      expect(rangeRef.overlaps(textRef)).toBe(false)
    })

    it("should return false for ranges on different paths", () => {
      handle.change(d => {
        d.text1 = "Hello"
        d.text2 = "World"
      })

      const range1 = handle.sub("text1", cursor(0, 5))
      const range2 = handle.sub("text2", cursor(0, 5))

      expect(range1.overlaps(range2)).toBe(false)
    })

    it("should return false for different documents", () => {
      const handle2 = repo.create()
      handle.change(d => {
        d.text = "Hello"
      })
      handle2.change((d: any) => {
        d.text = "World"
      })

      const range1 = handle.sub("text", cursor(0, 5))
      const range2 = handle2.sub("text", cursor(0, 5))

      expect(range1.overlaps(range2)).toBe(false)
    })

    it("should work with cursor ranges", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      // Create cursor-based ranges
      const range1 = handle.sub("text", cursor(0, 5))
      const range2 = handle.sub("text", cursor(3, 8))

      expect(range1.overlaps(range2)).toBe(true)
    })

    it("should handle ranges at start and end of text", () => {
      handle.change(d => {
        d.text = "Hello"
      })

      const range1 = handle.sub("text", cursor(0, 2))
      const range2 = handle.sub("text", cursor(3, 5))

      expect(range1.overlaps(range2)).toBe(false)
    })
  })

  describe("O(D) traversal architecture", () => {
    it("should resolve deeply nested paths efficiently", () => {
      handle.change(d => {
        d.a = { b: { c: { d: { e: { f: { g: { h: "deep" } } } } } } }
      })

      const ref = handle.sub("a", "b", "c", "d", "e", "f", "g", "h")
      expect(ref.doc()).toBe("deep")

      // Update deep value
      ref.change(() => "updated")
      expect(ref.doc()).toBe("updated")
    })

    it("should handle mixed segments", () => {
      handle.change(d => {
        d.items = [
          { id: "a", data: { name: "First" } },
          { id: "b", data: { name: "Second" } },
        ]
      })

      // Mix of: key -> index -> key -> key
      const ref = handle.sub("items", 1, "data", "name")
      expect(ref.doc()).toBe("Second")

      // Remove first item - second item moves to index 0
      handle.change(d => {
        d.items.shift()
      })

      // Numeric index now points to what's at position 1 (nothing left at index 1)
      expect(ref.doc()).toBeUndefined()
    })

    it("should handle unresolvable segments gracefully", () => {
      handle.change(d => {
        d.items = [{ name: "First" }, { name: "Second" }]
      })

      // Path with a match pattern that doesn't exist
      const ref = handle.sub("items", { name: "Third" }, "value")
      expect(ref.doc()).toBeUndefined()

      // Match segment should have undefined prop (no match)
      expect(ref.path.length).toBe(3)
      expect(ref.path[0].prop).toBe("items")
      expect(ref.path[1].prop).toBeUndefined() // Match found no match
      expect(ref.path[2].prop).toBe("value") // Key props are always resolved
    })

    it("should update props when document changes externally", () => {
      handle.change(d => {
        d.items = [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
          { id: "c", value: 3 },
        ]
      })

      // Use match pattern to track by id
      const ref = handle.sub("items", { id: "b" }, "value")
      expect(ref.doc()).toBe(2)
      expect(ref.path[1].prop).toBe(1) // index 1

      // Remove first item - second item moves to index 0
      handle.change(d => {
        d.items.shift()
      })

      expect(ref.doc()).toBe(2) // Still resolves to same object
      expect(ref.path[1].prop).toBe(0) // Now at index 0
    })

    it("should use match patterns to find items dynamically", () => {
      handle.change(d => {
        d.users = [
          { name: "Alice", active: true },
          { name: "Bob", active: true },
        ]
      })

      const ref = handle.sub("users", { active: true }, "name")
      expect(ref.doc()).toBe("Alice") // First match

      // The match pattern is retained
      expect(ref.path[1][KIND]).toBe("match")

      // If we change the property, the ref re-evaluates to find new match
      handle.change(d => {
        d.users[0].active = false
      })

      // Now Bob is the first match for { active: true }
      expect(ref.doc()).toBe("Bob")

      // If no more matches, returns undefined
      handle.change(d => {
        d.users[0].active = false // Bob (now at index 0 after shift) also set to false
      })

      // But wait - Bob is still at index 1, Alice is at index 0
      // Let's set Bob to false as well
      handle.change(d => {
        d.users[1].active = false
      })

      expect(ref.doc()).toBeUndefined()
    })

    it("should handle empty arrays and objects", () => {
      handle.change(d => {
        d.empty = []
        d.emptyObj = {}
      })

      const arrayRef = handle.sub("empty", 0)
      expect(arrayRef.doc()).toBeUndefined()

      const objRef = handle.sub("emptyObj", "key")
      expect(objRef.doc()).toBeUndefined()
    })

    it("should handle null values in path", () => {
      handle.change(d => {
        d.nullValue = null
        d.nested = { exists: "value" }
      })

      const nullRef = handle.sub("nullValue", "anything")
      expect(nullRef.doc()).toBeUndefined()

      // Accessing missing key should also return undefined
      const missingRef = handle.sub("nested", "missing", "more")
      expect(missingRef.doc()).toBeUndefined()
    })

    it("should handle ranges at various depths", () => {
      handle.change(d => {
        d.texts = {
          first: "Hello World",
          second: "Goodbye Moon",
        }
      })

      const ref1 = handle.sub("texts", "first", cursor(0, 5))
      expect(ref1.doc()).toBe("Hello")

      const ref2 = handle.sub("texts", "second", cursor(8, 12))
      expect(ref2.doc()).toBe("Moon")
    })

    it("should handle all segment types in one path", () => {
      handle.change(d => {
        d.root = {
          items: [
            { type: "text", content: "Hello World" },
            { type: "text", content: "Foo Bar" },
          ],
        }
      })

      // key -> key -> match -> key -> cursors
      const ref = handle.sub(
        "root",
        "items",
        { type: "text" },
        "content",
        cursor(0, 5)
      )

      expect(ref.doc()).toBe("Hello")
    })
  })

  describe("change shorthand", () => {
    it("should accept direct primitive value for strings", () => {
      handle.change(d => {
        d.theme = "light"
      })

      const themeRef = handle.sub("theme")
      themeRef.change("dark")
      expect(themeRef.doc()).toBe("dark")
    })

    it("should accept direct primitive value for numbers", () => {
      handle.change(d => {
        d.counter = 0
      })

      const counterRef = handle.sub("counter")
      counterRef.change(42)
      expect(counterRef.doc()).toBe(42)
    })

    it("should accept direct primitive value for booleans", () => {
      handle.change(d => {
        d.enabled = false
      })

      const enabledRef = handle.sub("enabled")
      enabledRef.change(true)
      expect(enabledRef.doc()).toBe(true)
    })

    it("should still accept function form", () => {
      handle.change(d => {
        d.counter = 10
      })

      const counterRef = handle.sub("counter")
      counterRef.change((n: any) => n * 2)
      expect(counterRef.doc()).toBe(20)
    })
  })

  describe("ref caching", () => {
    it("should return same ref instance for same path", () => {
      handle.change(d => {
        d.value = 42
      })

      const ref1 = handle.sub("value")
      const ref2 = handle.sub("value")

      expect(ref1).toBe(ref2)
    })

    it("should return different refs for different paths", () => {
      handle.change(d => {
        d.a = 1
        d.b = 2
      })

      const refA = handle.sub("a")
      const refB = handle.sub("b")

      expect(refA).not.toBe(refB)
    })

    it("should return different refs for different handles", () => {
      const handle2 = repo.create()
      handle.change(d => {
        d.value = 1
      })
      handle2.change((d: any) => {
        d.value = 2
      })

      const ref1 = handle.sub("value")
      const ref2 = handle2.sub("value")

      expect(ref1).not.toBe(ref2)
    })

    it("should cache refs with nested paths", () => {
      handle.change(d => {
        d.user = { profile: { name: "Alice" } }
      })

      const ref1 = handle.sub("user", "profile", "name")
      const ref2 = handle.sub("user", "profile", "name")

      expect(ref1).toBe(ref2)
    })

    it("should cache refs with numeric indices", () => {
      handle.change(d => {
        d.items = ["a", "b", "c"]
      })

      const ref1 = handle.sub("items", 1)
      const ref2 = handle.sub("items", 1)

      expect(ref1).toBe(ref2)
    })

    it("should cache refs with pattern matches", () => {
      handle.change(d => {
        d.users = [{ id: "alice", name: "Alice" }]
      })

      const ref1 = handle.sub("users", { id: "alice" })
      const ref2 = handle.sub("users", { id: "alice" })

      expect(ref1).toBe(ref2)
    })
  })
})
