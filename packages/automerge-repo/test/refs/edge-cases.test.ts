import { describe, it, expect, beforeEach } from "vitest"
import * as Automerge from "@automerge/automerge"
import { Repo } from "../../src/Repo.js"
import type { DocHandle } from "../../src/DocHandle.js"
import { cursor } from "../../src/refs/utils.js"
import {
  parsePath,
  parseSegment,
  serializeSegment,
  parseRefUrl,
} from "../../src/refs/parser.js"
import { isValidRefUrl } from "../../src/refs/guards.js"
import { KIND, RefUrl } from "../../src/refs/types.js"
import { splice } from "../../src/index.js"

describe("Edge Cases", () => {
  let repo: Repo
  let handle: DocHandle<any>

  beforeEach(() => {
    repo = new Repo()
    handle = repo.create()
  })

  describe("cursor() edge cases", () => {
    /**
     * Automerge cursor behavior:
     * - Negative positions are clamped to 0
     * - Positions beyond string length are clamped to string length
     * - Empty strings allow cursor at position 0
     * - Inverted ranges (start > end) result in empty string from slice()
     * - Zero-width ranges (start === end) return empty string
     */
    it("should follow Automerge cursor clamping behavior", () => {
      handle.change(d => {
        d.text = "Hello"
        d.empty = ""
      })

      // Zero-width cursor range
      expect(handle.ref("text", cursor(2, 2)).value()).toBe("")

      // Empty string allows cursor at 0
      expect(handle.ref("empty", cursor(0, 0)).value()).toBe("")

      // Negative positions clamped to 0
      expect(handle.ref("text", cursor(-5, 3)).value()).toBe("Hel")

      // Out-of-bounds positions clamped to string length
      expect(handle.ref("text", cursor(0, 100)).value()).toBe("Hello")

      // Inverted range (start > end) returns empty string
      expect(handle.ref("text", cursor(4, 2)).value()).toBe("")
    })

    it("should track cursors when text around them changes", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      const ref = handle.ref("text", cursor(6, 11)) // "World"
      expect(ref.value()).toBe("World")

      // Delete "Hello " - cursors track the content
      handle.change(d => {
        splice(d, ["text"], 0, 6, "")
      })
      expect(ref.value()).toBe("World")

      // Delete "World" entirely - cursors collapse
      handle.change(d => {
        splice(d, ["text"], 0, 5, "")
      })
      expect(ref.value()).toBe("")
    })

    it("should throw error when cursor() is followed by more segments", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      // cursor() must be the last segment - segments after it are an error
      expect(() => {
        handle.ref("text", cursor(0, 5), "invalid")
      }).toThrow("cursor() must be the last segment")
    })
  })

  describe("parser edge cases - keys", () => {
    /**
     * New encoding scheme - keys are default, special prefixes for other types:
     * - `@n` for indices
     * - `{...}` for match patterns
     * - `[...]` for cursor ranges
     * - `~` escapes keys that start with @, {, [, or ~
     *
     * This means:
     * - Numeric keys like "123" round-trip correctly (they're just keys!)
     * - Keys starting with special chars get escaped with ~
     * - Slashes are URL-encoded as %2F
     */

    it("should round-trip numeric-looking keys correctly", () => {
      handle.change(d => {
        d["123"] = "value at string key '123'"
      })

      // Ref creation works - stores as key segment
      const ref = handle.ref("123")
      expect(ref.path[0][KIND]).toBe("key")
      expect((ref.path[0] as any).key).toBe("123")
      expect(ref.value()).toBe("value at string key '123'")

      // URL serialization - "123" is just a key (no @ prefix)
      const url = ref.url
      expect(url).toContain("/123")

      // Round-trips correctly as key!
      const parsed = parseRefUrl(url)
      expect(parsed.segments[0][KIND]).toBe("key")
      expect((parsed.segments[0] as any).key).toBe("123")
    })

    it("should handle key containing dash (round-trips correctly)", () => {
      handle.change(d => {
        d["my-key"] = "value"
      })

      const ref = handle.ref("my-key")
      const url = ref.url

      // Dash is fine in keys (only [cursor-cursor] is special)
      const parsed = parseRefUrl(url)
      expect(parsed.segments[0][KIND]).toBe("key")
      expect((parsed.segments[0] as any).key).toBe("my-key")
    })

    it("should handle key starting with colon (round-trips correctly)", () => {
      handle.change(d => {
        d[":special"] = "value"
      })

      const ref = handle.ref(":special")
      const url = ref.url

      // Colons are fine in keys now
      const parsed = parseRefUrl(url)
      expect(parsed.segments[0][KIND]).toBe("key")
      expect((parsed.segments[0] as any).key).toBe(":special")
    })

    it("should escape and round-trip key starting with opening brace", () => {
      handle.change(d => {
        d["{notjson"] = "value"
      })

      // Ref creation works
      const ref = handle.ref("{notjson")
      expect(ref.value()).toBe("value")

      // URL should have backslash escape prefix (%5C is URL-encoded \)
      const url = ref.url
      expect(url).toContain("%5C%7Bnotjson") // \{notjson URL-encoded

      // Round-trips correctly
      const parsed = parseRefUrl(url)
      expect(parsed.segments[0][KIND]).toBe("key")
      expect((parsed.segments[0] as any).key).toBe("{notjson")
    })

    it("should round-trip key containing slash via URL encoding", () => {
      handle.change(d => {
        d["path/with/slashes"] = "value"
      })

      // Ref creation works
      const ref = handle.ref("path/with/slashes")
      expect(ref.value()).toBe("value")

      // Slashes are URL-encoded, not split
      const url = ref.url
      expect(url).toContain("path%2Fwith%2Fslashes")

      // Round-trips correctly as single key
      const parsed = parseRefUrl(url)
      expect(parsed.segments.length).toBe(1)
      expect((parsed.segments[0] as any).key).toBe("path/with/slashes")
    })

    it("should handle empty string key", () => {
      handle.change(d => {
        d[""] = "empty key value"
      })

      // Ref creation works
      const ref = handle.ref("")
      expect(ref.value()).toBe("empty key value")
    })

    it("should escape key starting with @", () => {
      handle.change(d => {
        d["@mention"] = "value"
      })

      const ref = handle.ref("@mention")
      const url = ref.url

      // Should be escaped with backslash (%5C is URL-encoded \)
      expect(url).toContain("%5C%40mention") // \@mention URL-encoded

      // Round-trips correctly
      const parsed = parseRefUrl(url)
      expect(parsed.segments[0][KIND]).toBe("key")
      expect((parsed.segments[0] as any).key).toBe("@mention")
    })

    it("should escape key starting with [", () => {
      handle.change(d => {
        d["[array]"] = "value"
      })

      const ref = handle.ref("[array]")
      const url = ref.url

      // Should be escaped with backslash (%5C is URL-encoded \)
      expect(url).toContain("%5C%5Barray%5D") // \[array] URL-encoded

      // Round-trips correctly
      const parsed = parseRefUrl(url)
      expect(parsed.segments[0][KIND]).toBe("key")
      expect((parsed.segments[0] as any).key).toBe("[array]")
    })

    it("should escape key starting with backslash", () => {
      handle.change(d => {
        d["\\backslash"] = "value"
      })

      const ref = handle.ref("\\backslash")
      const url = ref.url

      // Should be double-escaped: \\ becomes %5C%5C (two URL-encoded backslashes)
      expect(url).toContain("%5C%5Cbackslash")

      // Round-trips correctly
      const parsed = parseRefUrl(url)
      expect(parsed.segments[0][KIND]).toBe("key")
      expect((parsed.segments[0] as any).key).toBe("\\backslash")
    })

    it("should NOT escape key starting with ~ (tilde is no longer special)", () => {
      handle.change(d => {
        d["~tilde"] = "value"
      })

      const ref = handle.ref("~tilde")
      const url = ref.url

      // Tilde is no longer special - just URL-encoded as-is
      expect(url).toContain("~tilde")
      expect(url).not.toContain("%5C") // No backslash escape

      // Round-trips correctly
      const parsed = parseRefUrl(url)
      expect(parsed.segments[0][KIND]).toBe("key")
      expect((parsed.segments[0] as any).key).toBe("~tilde")
    })
  })

  describe("parser edge cases - parsing", () => {
    it("should parse empty path as empty array", () => {
      const segments = parsePath("")
      expect(segments).toEqual([])
    })

    it("should throw on path with only slashes", () => {
      expect(() => parsePath("/")).toThrow()
      expect(() => parsePath("//")).toThrow()
      expect(() => parsePath("///")).toThrow()
    })

    it("should throw on path with empty segment (double slash)", () => {
      expect(() => parsePath("foo//bar")).toThrow("empty segment")
    })

    it("should handle leading/trailing slashes", () => {
      const segments = parsePath("/foo/bar/")
      expect(segments.length).toBe(2)
      expect((segments[0] as any).key).toBe("foo")
      expect((segments[1] as any).key).toBe("bar")
    })

    it("should parse segment that looks like invalid JSON", () => {
      // Starts with { but isn't valid JSON
      expect(() => parseSegment("{notjson}")).toThrow("Invalid match pattern")
    })

    it("should parse cursor range with bracket format", () => {
      const segment = parseSegment("[abc123-def456]")
      expect(segment[KIND]).toBe("cursors")
      expect((segment as any).start).toBe("abc123")
      expect((segment as any).end).toBe("def456")
    })

    it("should parse collapsed cursor (single cursor)", () => {
      const segment = parseSegment("[abc123]")
      expect(segment[KIND]).toBe("cursors")
      expect((segment as any).start).toBe("abc123")
      expect((segment as any).end).toBe("abc123") // Same as start
    })

    it("should throw on empty cursor brackets", () => {
      expect(() => parseSegment("[]")).toThrow("empty brackets")
    })

    it("should parse index with @ prefix", () => {
      const segment = parseSegment("@42")
      expect(segment[KIND]).toBe("index")
      expect((segment as any).index).toBe(42)
    })

    it("should throw for invalid @ usage (not followed by digits)", () => {
      // @prefix is reserved for indices - invalid use throws
      // To use "@notanumber" as a key, escape it: ~@notanumber
      expect(() => parseSegment("@notanumber")).toThrow(
        'Invalid segment: "@notanumber"'
      )
    })
  })

  describe("parser edge cases - match patterns", () => {
    it("should handle empty match pattern", () => {
      handle.change(d => {
        d.items = [{ a: 1 }, { b: 2 }]
      })

      // Empty pattern {} should match any object
      const ref = handle.ref("items", {})
      expect(ref.value()).toEqual({ a: 1 }) // First item
    })

    it("should handle match pattern with null value", () => {
      handle.change(d => {
        d.items = [{ status: null }, { status: "active" }]
      })

      const ref = handle.ref("items", { status: null })
      expect(ref.value()).toEqual({ status: null })
    })

    it("should handle match pattern with boolean values", () => {
      handle.change(d => {
        d.items = [{ done: false }, { done: true }]
      })

      const trueRef = handle.ref("items", { done: true })
      expect(trueRef.value()).toEqual({ done: true })

      const falseRef = handle.ref("items", { done: false })
      expect(falseRef.value()).toEqual({ done: false })
    })

    it("should serialize and deserialize match patterns correctly", () => {
      const segment = {
        [KIND]: "match" as const,
        match: { id: "test", count: 42, active: true },
      }
      const serialized = serializeSegment(segment)
      // Match patterns are URL-encoded to protect slashes and special characters
      expect(serialized).toBe(
        encodeURIComponent('{"id":"test","count":42,"active":true}')
      )

      const parsed = parseSegment(serialized)
      expect(parsed[KIND]).toBe("match")
      expect((parsed as any).match).toEqual({
        id: "test",
        count: 42,
        active: true,
      })
    })
  })

  describe("path construction edge cases", () => {
    it("should handle negative array index", () => {
      handle.change(d => {
        d.items = ["a", "b", "c"]
      })

      // Negative indices don't make sense in Automerge
      const ref = handle.ref("items", -1)
      expect(ref.value()).toBeUndefined()
    })

    it("should handle float array index", () => {
      handle.change(d => {
        d.items = ["a", "b", "c"]
      })

      // 1.5 will be used as-is, which JS will truncate to 1 when indexing
      const ref = handle.ref("items", 1.5)
      // JavaScript arrays coerce 1.5 to "1.5" as a key, not index 1
      expect(ref.value()).toBeUndefined()
    })

    it("should handle NaN as index", () => {
      handle.change(d => {
        d.items = ["a", "b", "c"]
      })

      const ref = handle.ref("items", NaN)
      expect(ref.value()).toBeUndefined()
    })

    it("should handle Infinity as index", () => {
      handle.change(d => {
        d.items = ["a", "b", "c"]
      })

      const ref = handle.ref("items", Infinity)
      expect(ref.value()).toBeUndefined()
    })

    it("should handle very large index", () => {
      handle.change(d => {
        d.items = ["a"]
      })

      const ref = handle.ref("items", Number.MAX_SAFE_INTEGER)
      expect(ref.value()).toBeUndefined()
    })

    it("should handle root ref (empty path)", () => {
      handle.change(d => {
        d.title = "Test"
        d.count = 42
      })

      const rootRef = handle.ref()
      const value = rootRef.value()
      expect(value).toHaveProperty("title", "Test")
      expect(value).toHaveProperty("count", 42)
    })
  })

  describe("URL edge cases", () => {
    it("should reject invalid URL prefix", () => {
      expect(isValidRefUrl("http://example.com")).toBe(false)
      expect(isValidRefUrl("automerge-repo:abc")).toBe(false)
    })

    it("should reject URL with multiple # (heads sections)", () => {
      expect(() => {
        parseRefUrl("automerge:abc/path#head1#head2" as any)
      }).toThrow("multiple heads sections")
    })

    it("should handle URL with no path", () => {
      const parsed = parseRefUrl("automerge:docid123" as any)
      expect(parsed.documentId).toBe("docid123")
      expect(parsed.segments).toEqual([])
    })

    it("should handle URL with only heads", () => {
      const parsed = parseRefUrl("automerge:docid123#head1|head2" as RefUrl)
      expect(parsed.documentId).toBe("docid123")
      expect(parsed.segments).toEqual([])
      expect(parsed.heads).toEqual(["head1", "head2"])
    })

    // TODO: this makes me think we should prefix indexes with a colon or possibly another character
    it("should preserve key vs index distinction through URL round-trip", () => {
      handle.change(d => {
        d["0"] = "string key"
        d.items = ["index"]
      })

      // The URL format uses numbers for indices, so "0" as a key
      // will be indistinguishable from index 0 after parsing
      const stringKeyRef = handle.ref("0")
      const url = stringKeyRef.url

      // This is a known limitation: URL parsing treats "0" as index, not key
      // The URL will contain "/0" which parses as index segment
      expect(url).toContain("/0")
    })
  })

  describe("MutableText edge cases", () => {
    it("should handle splice at start of string", () => {
      handle.change(d => {
        d.text = "World"
      })

      const ref = handle.ref("text")
      ref.change((text: any) => {
        text.splice(0, 0, "Hello ")
      })

      expect(handle.doc().text).toBe("Hello World")
    })

    it("should handle splice at end of string", () => {
      handle.change(d => {
        d.text = "Hello"
      })

      const ref = handle.ref("text")
      ref.change((text: any) => {
        text.splice(5, 0, " World")
      })

      expect(handle.doc().text).toBe("Hello World")
    })

    it("should handle splice deleting entire string", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      const ref = handle.ref("text")
      ref.change((text: any) => {
        text.splice(0, 11, "")
      })

      expect(handle.doc().text).toBe("")
    })

    it("should handle updateText to empty string", () => {
      handle.change(d => {
        d.text = "Hello"
      })

      const ref = handle.ref("text")
      ref.change((text: any) => {
        text.updateText("")
      })

      expect(handle.doc().text).toBe("")
    })

    it("should handle updateText on empty string", () => {
      handle.change(d => {
        d.text = ""
      })

      const ref = handle.ref("text")
      ref.change((text: any) => {
        text.updateText("New content")
      })

      expect(handle.doc().text).toBe("New content")
    })
  })

  describe("concurrent/state edge cases", () => {
    it("should handle ref to value that gets deleted", () => {
      handle.change(d => {
        d.nested = { deep: { value: 42 } }
      })

      const ref = handle.ref("nested", "deep", "value")
      expect(ref.value()).toBe(42)

      // Delete the intermediate object
      handle.change(d => {
        delete d.nested.deep
      })

      expect(ref.value()).toBeUndefined()
    })

    it("should handle ref to array element when array is replaced", () => {
      handle.change(d => {
        d.items = ["a", "b", "c"]
      })

      const ref = handle.ref("items", 1)
      expect(ref.value()).toBe("b")

      // Replace entire array
      handle.change(d => {
        d.items = ["x", "y"]
      })

      // Numeric index still works on new array
      expect(ref.value()).toBe("y")
    })

    it("should handle match ref when matched item is deleted", () => {
      handle.change(d => {
        d.items = [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
        ]
      })

      const ref = handle.ref("items", { id: "b" }, "value")
      expect(ref.value()).toBe(2)

      // Delete the matched item using Automerge's deleteAt
      // (can't use .filter() in Automerge change callbacks - creates references)
      handle.change(d => {
        d.items.deleteAt(1) // Delete item at index 1 (the one with id: "b")
      })

      expect(ref.value()).toBeUndefined()
    })

    it("should handle multiple refs to same location", () => {
      handle.change(d => {
        d.counter = 0
      })

      const ref1 = handle.ref("counter")
      const ref2 = handle.ref("counter")

      // Both refs see the same value
      expect(ref1.value()).toBe(0)
      expect(ref2.value()).toBe(0)

      // Change via ref1
      ref1.change(() => 10)

      // Both refs should see the change
      expect(ref1.value()).toBe(10)
      expect(ref2.value()).toBe(10)
    })
  })

  describe("serialization round-trip edge cases", () => {
    it("should round-trip match pattern with multiple fields", () => {
      handle.change(d => {
        d.items = [{ type: "task", status: "done", priority: 1 }]
      })

      const ref = handle.ref("items", { type: "task", status: "done" })
      const url = ref.url

      const parsed = parseRefUrl(url)
      const matchSegment = parsed.segments[1]
      expect(matchSegment[KIND]).toBe("match")
      expect((matchSegment as any).match).toEqual({
        type: "task",
        status: "done",
      })
    })

    it("should round-trip cursor range", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      const ref = handle.ref("text", cursor(0, 5))
      const url = ref.url

      // Parse and verify new bracket format: [cursor-cursor]
      expect(url).toMatch(/\[\d+@[a-f0-9]+-\d+@[a-f0-9]+\]$/)
    })
  })

  describe("URI encoding survival - double encoding", () => {
    /**
     * When ref URLs are placed in browser address bars or used as query params,
     * they get URI-encoded again. This tests that our encoding scheme survives
     * this double-encoding:
     *
     * 1. Create ref URL (contains internal URI encoding, e.g. %2F for /)
     * 2. Browser/system URI-encodes the whole URL (% becomes %25)
     * 3. Browser/system URI-decodes when navigating/extracting
     * 4. Our parser decodes the ref URL correctly
     *
     * This should be a no-op since encodeURIComponent(url) + decodeURIComponent
     * returns the original url.
     */

    it("should survive full URI encoding/decoding - simple key", () => {
      handle.change(d => {
        d.title = "Hello"
      })

      const ref = handle.ref("title")
      const originalUrl = ref.url

      // Simulate putting URL in browser address bar (gets encoded)
      const browserEncoded = encodeURIComponent(originalUrl)
      // Simulate extracting URL from address bar (gets decoded)
      const recovered = decodeURIComponent(browserEncoded)

      // URL should be unchanged
      expect(recovered).toBe(originalUrl)

      // Should still parse correctly
      const parsed = parseRefUrl(recovered as any)
      expect(parsed.segments[0][KIND]).toBe("key")
      expect((parsed.segments[0] as any).key).toBe("title")
    })

    it("should survive full URI encoding/decoding - key with slash", () => {
      handle.change(d => {
        d["path/with/slashes"] = "value"
      })

      const ref = handle.ref("path/with/slashes")
      const originalUrl = ref.url

      // Original URL should have %2F for slashes
      expect(originalUrl).toContain("path%2Fwith%2Fslashes")

      // Simulate browser double-encoding and decoding
      const browserEncoded = encodeURIComponent(originalUrl)
      // The %2F becomes %252F (% encoded as %25)
      expect(browserEncoded).toContain("path%252Fwith%252Fslashes")

      const recovered = decodeURIComponent(browserEncoded)

      // Should get back original URL
      expect(recovered).toBe(originalUrl)

      // Should parse correctly to original key
      const parsed = parseRefUrl(recovered as any)
      expect((parsed.segments[0] as any).key).toBe("path/with/slashes")
    })

    it("should survive full URI encoding/decoding - escaped key with @", () => {
      handle.change(d => {
        d["@mention"] = "value"
      })

      const ref = handle.ref("@mention")
      const originalUrl = ref.url

      // Should have backslash escape prefix (%5C) and URL-encoded @
      expect(originalUrl).toContain("%5C%40mention")

      // Simulate double encoding/decoding
      const recovered = decodeURIComponent(encodeURIComponent(originalUrl))

      expect(recovered).toBe(originalUrl)

      const parsed = parseRefUrl(recovered as any)
      expect((parsed.segments[0] as any).key).toBe("@mention")
    })

    it("should survive full URI encoding/decoding - match pattern", () => {
      handle.change(d => {
        d.items = [{ id: "test/path", value: 1 }]
      })

      const ref = handle.ref("items", { id: "test/path" })
      const originalUrl = ref.url

      // Match pattern is URL-encoded to protect slashes from being path separators
      // The JSON {"id":"test/path"} becomes URL-encoded
      expect(originalUrl).toContain(encodeURIComponent('{"id":"test/path"}'))

      const recovered = decodeURIComponent(encodeURIComponent(originalUrl))

      expect(recovered).toBe(originalUrl)

      // Most importantly: the match pattern with slash round-trips correctly!
      const parsed = parseRefUrl(recovered as any)
      expect(parsed.segments[1][KIND]).toBe("match")
      expect((parsed.segments[1] as any).match).toEqual({ id: "test/path" })
    })

    it("should survive full URI encoding/decoding - cursor range", () => {
      handle.change(d => {
        d.text = "Hello World"
      })

      const ref = handle.ref("text", cursor(0, 5))
      const originalUrl = ref.url

      // Cursor format uses @ which might be encoded
      expect(originalUrl).toMatch(/\[\d+@[a-f0-9]+-\d+@[a-f0-9]+\]$/)

      const recovered = decodeURIComponent(encodeURIComponent(originalUrl))

      expect(recovered).toBe(originalUrl)

      // Value should still resolve correctly
      const parsed = parseRefUrl(recovered as any)
      expect(parsed.segments[1][KIND]).toBe("cursors")
    })

    it("should survive full URI encoding/decoding - complex nested path", () => {
      handle.change(d => {
        d["root/path"] = {
          items: [{ "@id": "test~value" }],
        }
      })

      const ref = handle.ref("root/path", "items", { "@id": "test~value" })
      const originalUrl = ref.url

      const recovered = decodeURIComponent(encodeURIComponent(originalUrl))

      expect(recovered).toBe(originalUrl)

      const parsed = parseRefUrl(recovered as any)
      expect((parsed.segments[0] as any).key).toBe("root/path")
      expect((parsed.segments[1] as any).key).toBe("items")
      expect((parsed.segments[2] as any).match).toEqual({
        "@id": "test~value",
      })
    })

    it("should survive full URI encoding/decoding - with heads", () => {
      handle.change(d => {
        d.counter = 1
      })

      // Get actual heads in hex format
      const heads = Automerge.getHeads(handle.doc())

      // Create a view handle with these heads
      const viewHandle = handle.view(handle.heads())
      const ref = viewHandle.ref("counter")
      const originalUrl = ref.url

      // Should have heads section with pipe separator
      expect(originalUrl).toContain("#")
      expect(originalUrl).toContain(heads[0])

      const recovered = decodeURIComponent(encodeURIComponent(originalUrl))

      expect(recovered).toBe(originalUrl)

      const parsed = parseRefUrl(recovered as any)
      expect(parsed.heads).toEqual(heads)
    })

    it("should survive URL query param encoding/decoding", () => {
      handle.change(d => {
        d["special&chars=here"] = "value"
      })

      const ref = handle.ref("special&chars=here")
      const originalUrl = ref.url

      // Simulate being used as a query param value
      // In query strings, & and = have special meaning
      const asQueryParam = `?ref=${encodeURIComponent(originalUrl)}`

      // Extract and decode
      const extracted = decodeURIComponent(asQueryParam.split("=")[1])

      expect(extracted).toBe(originalUrl)

      const parsed = parseRefUrl(extracted as any)
      expect((parsed.segments[0] as any).key).toBe("special&chars=here")
    })

    it("should survive multiple levels of URI encoding", () => {
      handle.change(d => {
        d["key%with%percent"] = "value"
      })

      const ref = handle.ref("key%with%percent")
      const originalUrl = ref.url

      // The % should be encoded as %25 in the URL
      expect(originalUrl).toContain("key%25with%25percent")

      // First level of encoding (e.g., embedding in another URL)
      const level1 = encodeURIComponent(originalUrl)
      // Second level (e.g., that URL is then embedded again)
      const level2 = encodeURIComponent(level1)

      // Decode both levels
      const decoded1 = decodeURIComponent(level2)
      const decoded2 = decodeURIComponent(decoded1)

      expect(decoded2).toBe(originalUrl)

      const parsed = parseRefUrl(decoded2 as any)
      expect((parsed.segments[0] as any).key).toBe("key%with%percent")
    })

    it("should handle Unicode characters through encoding/decoding", () => {
      handle.change(d => {
        d["日本語キー"] = "value"
        d["emoji🎉key"] = "other"
      })

      const ref1 = handle.ref("日本語キー")
      const originalUrl1 = ref1.url

      const ref2 = handle.ref("emoji🎉key")
      const originalUrl2 = ref2.url

      // Simulate browser encoding/decoding
      const recovered1 = decodeURIComponent(encodeURIComponent(originalUrl1))
      const recovered2 = decodeURIComponent(encodeURIComponent(originalUrl2))

      expect(recovered1).toBe(originalUrl1)
      expect(recovered2).toBe(originalUrl2)

      const parsed1 = parseRefUrl(recovered1 as any)
      const parsed2 = parseRefUrl(recovered2 as any)

      expect((parsed1.segments[0] as any).key).toBe("日本語キー")
      expect((parsed2.segments[0] as any).key).toBe("emoji🎉key")
    })

    it("should handle fragment identifier in ref URL through encoding", () => {
      handle.change(d => {
        d.value = 1
      })

      // Get actual heads and create a view handle
      const heads = Automerge.getHeads(handle.doc())
      const viewHandle = handle.view(handle.heads())
      const ref = viewHandle.ref("value")
      const originalUrl = ref.url

      // The # is part of the ref URL format
      expect(originalUrl).toContain("#")

      // In a real browser, # has special meaning (fragment identifier)
      // encodeURIComponent encodes # as %23
      const encoded = encodeURIComponent(originalUrl)
      expect(encoded).toContain("%23")

      const recovered = decodeURIComponent(encoded)
      expect(recovered).toBe(originalUrl)

      const parsed = parseRefUrl(recovered as any)
      expect(parsed.heads).toEqual(heads)
    })
  })
})
