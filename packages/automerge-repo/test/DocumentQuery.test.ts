import { next as A } from "@automerge/automerge"
import { describe, expect, it, vi } from "vitest"
import { DocumentQuery } from "../src/DocumentQuery.js"
import type { DocumentId } from "../src/types.js"

const docId = "test-doc-id" as DocumentId

function makeBlob(value: Record<string, unknown>): Uint8Array {
  const doc = A.from(value)
  return A.save(doc)
}

/** Load data into a query's handle. */
function loadInto(query: DocumentQuery<any>, blobs: Uint8Array[]) {
  query.handle.update(doc => {
    let result = doc
    for (const blob of blobs) {
      result = A.loadIncremental(result, blob)
    }
    return result
  })
}

describe("DocumentQuery", () => {
  describe("initial state", () => {
    it("starts in loading state", () => {
      const query = new DocumentQuery(docId)
      expect(query.peek().state).toBe("loading")
    })

    it("has a handle from construction", () => {
      const query = new DocumentQuery(docId)
      expect(query.handle).toBeTruthy()
      expect(query.handle.documentId).toBe(docId)
    })
  })

  describe("loading data", () => {
    it("transitions to ready when data is provided", () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("test-source")
      loadInto(query, [makeBlob({ count: 0 })])

      const state = query.peek()
      expect(state.state).toBe("ready")
      expect(state.state === "ready" && state.handle).toBeDefined()
    })

    it("creates a handle with the provided data", () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("test-source")
      loadInto(query, [makeBlob({ count: 42 })])

      const state = query.peek()
      if (state.state !== "ready") throw new Error("expected ready")
      expect(state.handle.doc()).toHaveProperty("count", 42)
    })

    it("updates existing handle when called again", () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("test-source")
      loadInto(query, [makeBlob({ count: 1 })])

      const state1 = query.peek()
      if (state1.state !== "ready") throw new Error("expected ready")
      const handle = state1.handle

      // Make a change blob based on the existing doc
      const changed = A.change(A.clone(handle.doc()!), doc => {
        ;(doc as any).count = 2
      })
      const changes = A.getChanges(handle.doc()!, changed)

      loadInto(query, changes)

      const state2 = query.peek()
      if (state2.state !== "ready") throw new Error("expected ready")
      // Same handle instance
      expect(state2.handle).toBe(handle)
      expect(state2.handle.doc()).toHaveProperty("count", 2)
    })
  })

  describe("source states", () => {
    it("stays loading while any source is pending", () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("source-a")
      query.sourcePending("source-b")
      query.sourceUnavailable("source-a")

      expect(query.peek().state).toBe("loading")
    })

    it("transitions to unavailable when all sources are unavailable", () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("source-a")
      query.sourcePending("source-b")
      query.sourceUnavailable("source-a")
      query.sourceUnavailable("source-b")

      expect(query.peek().state).toBe("unavailable")
    })

    it("transitions from unavailable back to loading on sourcePending", () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("source-a")
      query.sourceUnavailable("source-a")
      expect(query.peek().state).toBe("unavailable")

      query.sourcePending("source-a")
      expect(query.peek().state).toBe("loading")
    })

    it("transitions from unavailable to ready when data arrives", () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("source-a")
      query.sourceUnavailable("source-a")
      expect(query.peek().state).toBe("unavailable")

      loadInto(query, [makeBlob({ count: 0 })])
      expect(query.peek().state).toBe("ready")
    })

    it("stays ready even if some sources become unavailable", () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("source-a")
      query.sourcePending("source-b")
      loadInto(query, [makeBlob({ count: 0 })])
      expect(query.peek().state).toBe("ready")

      query.sourceUnavailable("source-b")
      expect(query.peek().state).toBe("ready")
    })
  })

  describe("subscribe", () => {
    it("notifies subscribers of state changes", () => {
      const query = new DocumentQuery(docId)
      const states: string[] = []
      query.subscribe(state => states.push(state.state))

      query.sourcePending("test")
      loadInto(query, [makeBlob({ count: 0 })])

      expect(states).toEqual(["ready"])
    })

    it("does not notify when state doesn't change", () => {
      const query = new DocumentQuery(docId)
      const callback = vi.fn()
      query.subscribe(callback)

      // Already in loading, adding a pending source doesn't change state
      query.sourcePending("test")
      expect(callback).not.toHaveBeenCalled()
    })

    it("unsubscribes correctly", () => {
      const query = new DocumentQuery(docId)
      const callback = vi.fn()
      const unsubscribe = query.subscribe(callback)

      unsubscribe()
      query.sourcePending("test")
      loadInto(query, [makeBlob({ count: 0 })])

      expect(callback).not.toHaveBeenCalled()
    })

    it("notifies on transitions through multiple states", () => {
      const query = new DocumentQuery(docId)
      const states: string[] = []
      query.subscribe(state => states.push(state.state))

      query.sourcePending("test")
      query.sourceUnavailable("test") // loading → unavailable
      query.sourcePending("test") // unavailable → loading
      loadInto(query, [makeBlob({ count: 0 })]) // loading → ready

      expect(states).toEqual(["unavailable", "loading", "ready"])
    })
  })

  describe("whenReady", () => {
    it("resolves immediately when already ready", async () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("test")
      loadInto(query, [makeBlob({ count: 0 })])

      const handle = await query.whenReady()
      expect(handle.doc()).toHaveProperty("count", 0)
    })

    it("resolves when data arrives later", async () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("test")

      const promise = query.whenReady()

      // Data arrives asynchronously
      loadInto(query, [makeBlob({ count: 42 })])

      const handle = await promise
      expect(handle.doc()).toHaveProperty("count", 42)
    })

    it("rejects on failure", async () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("test")

      const promise = query.whenReady()
      query.fail(new Error("boom"))

      await expect(promise).rejects.toThrow("boom")
    })

    it("rejects immediately when already failed", async () => {
      const query = new DocumentQuery(docId)
      query.fail(new Error("already failed"))

      await expect(query.whenReady()).rejects.toThrow("already failed")
    })

    it("rejects when abort signal is already aborted", async () => {
      const query = new DocumentQuery(docId)
      const controller = new AbortController()
      controller.abort()

      await expect(
        query.whenReady({ signal: controller.signal })
      ).rejects.toThrow()
    })

    it("rejects when abort signal fires", async () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("test")
      const controller = new AbortController()

      const promise = query.whenReady({ signal: controller.signal })
      controller.abort()

      await expect(promise).rejects.toThrow()
    })

    it("cleans up signal listener on resolve", async () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("test")
      const controller = new AbortController()
      const removeSpy = vi.spyOn(controller.signal, "removeEventListener")

      const promise = query.whenReady({ signal: controller.signal })
      loadInto(query, [makeBlob({ count: 0 })])
      await promise

      expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function))
    })
  })

  describe("fail", () => {
    it("transitions to failed state", () => {
      const query = new DocumentQuery(docId)
      query.fail(new Error("something broke"))

      const state = query.peek()
      expect(state.state).toBe("failed")
      if (state.state === "failed") {
        expect(state.error.message).toBe("something broke")
      }
    })

    it("ignores further state changes after failure", () => {
      const query = new DocumentQuery(docId)
      query.fail(new Error("done"))

      query.sourcePending("test")
      loadInto(query, [makeBlob({ count: 0 })])

      expect(query.peek().state).toBe("failed")
    })
  })

  describe("auto-detection via handle", () => {
    it("transitions to ready when data is loaded into the handle", () => {
      const query = new DocumentQuery(docId)
      const doc = A.from({ count: 99 })
      query.handle.update(() => doc)

      const state = query.peek()
      expect(state.state).toBe("ready")
      if (state.state === "ready") {
        expect(state.handle).toBe(query.handle)
        expect(state.handle.doc()).toHaveProperty("count", 99)
      }
    })

    it("stays ready even if all sources become unavailable after data loaded", () => {
      const query = new DocumentQuery(docId)
      query.sourcePending("a")
      query.handle.update(() => A.from({ count: 1 }))
      expect(query.peek().state).toBe("ready")

      query.sourceUnavailable("a")
      expect(query.peek().state).toBe("ready")
    })
  })
})
