import { next as A } from "@automerge/automerge"
import { describe, expect, it, vi } from "vitest"
import {
  queryAtHeads,
  queryAtPath,
  toProgress,
  waitUntilReady,
  type QueryState,
} from "../src/DocumentQuery.js"
import { encodeHeads } from "../src/AutomergeUrl.js"
import type { DocumentId, UrlHeads } from "../src/types.js"
import { createTestQuery } from "./helpers/testHandle.js"

const docId = "test-doc-id" as DocumentId

function readyQuery<T>(value: T) {
  const query = createTestQuery<T>(docId)
  query.handle.update(() => A.from(value as any) as A.Doc<T>)
  query.ready()
  return query
}

describe("RootQuery", () => {
  it("starts loading and exposes only the observable surface", () => {
    const query = createTestQuery(docId)
    expect(query.state()).toEqual({ state: "loading" })
    expect(query.documentId).toBe(docId)
    expect("whenReady" in query).toBe(false)
  })

  it("moves between loading, unavailable and ready", () => {
    const query = createTestQuery(docId)
    const states: string[] = []
    query.subscribe(state => states.push(state.state))
    query.unavailable()
    query.loading()
    query.unavailable()
    query.ready()
    expect(states).toEqual([
      "loading",
      "unavailable",
      "loading",
      "unavailable",
      "ready",
    ])
    expect(query.state()).toEqual({ state: "ready", handle: query.handle })
  })

  it("does not leave ready for loading or unavailable", () => {
    const query = readyQuery({ count: 1 })
    query.loading()
    query.unavailable()
    expect(query.state().state).toBe("ready")
  })

  it.each([
    ["deleted", (q: ReturnType<typeof createTestQuery>) => q.deleted()],
    ["failed", (q: ReturnType<typeof createTestQuery>) => q.fail(new Error())],
  ] as const)("%s is terminal", (expected, settle) => {
    const query = createTestQuery(docId)
    settle(query)
    query.ready()
    query.loading()
    query.deleted()
    query.fail(new Error("later"))
    expect(query.state().state).toBe(expected)
    expect(query.terminal).toBe(true)
  })

  it("does not notify for repeated states", () => {
    const query = createTestQuery(docId)
    const callback = vi.fn()
    query.subscribe(callback)
    query.loading()
    query.unavailable()
    query.unavailable()
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it("isolates throwing and rejecting subscribers", async () => {
    const query = createTestQuery(docId)
    const later = vi.fn()
    query.subscribe(() => {
      throw new Error("sync")
    })
    query.subscribe(async () => {
      throw new Error("async")
    })
    query.subscribe(later)
    const waiting = waitUntilReady(query)
    query.ready()
    expect(later).toHaveBeenCalledTimes(2)
    await expect(waiting).resolves.toBe(query.handle)
  })

  it("delivers the current state synchronously on subscribe", () => {
    const query = readyQuery({ count: 1 })
    const callback = vi.fn()
    query.subscribe(callback)
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      state: "ready",
      handle: query.handle,
    })
  })

  it("derived queries deliver their current state on subscribe", () => {
    const query = readyQuery({ items: ["a"] })
    const future = A.change(A.clone(query.handle.fullDoc()), d => {
      d.items.push("b")
    })
    const atHeads = vi.fn()
    queryAtHeads(query, encodeHeads(A.getHeads(future))).subscribe(atHeads)
    expect(atHeads).toHaveBeenCalledExactlyOnceWith({ state: "loading" })
    const atPath = vi.fn()
    queryAtPath(query, ["items"] as any).subscribe(atPath)
    expect(atPath).toHaveBeenCalledOnce()
    expect(atPath.mock.calls[0][0].handle.doc()).toEqual(["a"])
  })

  it("unsubscribes", () => {
    const query = createTestQuery(docId)
    const callback = vi.fn()
    query.subscribe(callback)()
    query.ready()
    expect(callback).toHaveBeenCalledExactlyOnceWith({ state: "loading" })
  })
})

describe("waitUntilReady", () => {
  it("resolves immediately when ready", async () => {
    const query = readyQuery({ count: 1 })
    await expect(waitUntilReady(query)).resolves.toBe(query.handle)
  })

  it("waits through unavailable-free loading", async () => {
    const query = createTestQuery(docId)
    const waiting = waitUntilReady(query)
    query.ready()
    await expect(waiting).resolves.toBe(query.handle)
  })

  it.each([
    ["unavailable", "unavailable"],
    ["deleted", "deleted"],
  ] as const)("rejects on %s", async (state, message) => {
    const query = createTestQuery(docId)
    const waiting = waitUntilReady(query)
    query[state]()
    await expect(waiting).rejects.toThrow(message)
  })

  it("rejects with the failure error", async () => {
    const query = createTestQuery(docId)
    const error = new Error("boom")
    const waiting = waitUntilReady(query)
    query.fail(error)
    await expect(waiting).rejects.toBe(error)
  })

  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort("stop")
    await expect(
      waitUntilReady(createTestQuery(docId), controller.signal)
    ).rejects.toBe("stop")
  })

  it("rejects on abort and releases its subscription and listener", async () => {
    const query = createTestQuery(docId)
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    const subscribe = query.subscribe.bind(query)
    const unsubscribed = vi.fn()
    vi.spyOn(query, "subscribe").mockImplementation(callback => {
      const unsubscribe = subscribe(callback)
      return () => {
        unsubscribed()
        unsubscribe()
      }
    })
    const waiting = waitUntilReady(query, controller.signal)
    controller.abort("stop")
    await expect(waiting).rejects.toBe("stop")
    expect(unsubscribed).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  })
})

describe("queryAtHeads", () => {
  function future(query: ReturnType<typeof readyQuery<{ value: string }>>) {
    const v2 = A.change(A.clone(query.handle.fullDoc()), d => {
      d.value = "v2"
    })
    return { v2, heads: encodeHeads(A.getHeads(v2)) as UrlHeads }
  }

  it("passes through non-ready states", () => {
    const query = createTestQuery<{ value: string }>(docId)
    const atHeads = queryAtHeads(query, [] as unknown as UrlHeads)
    expect(atHeads.state().state).toBe("loading")
    query.unavailable()
    expect(atHeads.state().state).toBe("unavailable")
  })

  it("stays loading until the requested heads arrive, then yields a view", async () => {
    const query = readyQuery({ value: "v1" })
    const { v2, heads } = future(query)
    const atHeads = queryAtHeads(query, heads)
    expect(atHeads.state().state).toBe("loading")
    const states: string[] = []
    atHeads.subscribe(state => states.push(state.state))
    const waiting = waitUntilReady(atHeads)
    query.handle.update(() => v2)
    const view = await waiting
    expect(view.doc()?.value).toBe("v2")
    expect(view.isReadOnly()).toBe(true)
    expect(states).toEqual(["loading", "ready"])
  })

  it.each(["fail", "deleted"] as const)(
    "rejects a waiting caller and detaches on %s",
    async settle => {
      const query = readyQuery({ value: "v1" })
      const { heads } = future(query)
      const before = query.handle.listenerCount("heads-changed")
      const waiting = waitUntilReady(queryAtHeads(query, heads))
      expect(query.handle.listenerCount("heads-changed")).toBe(before + 1)
      if (settle === "fail") query.fail(new Error("gone"))
      else query.deleted()
      await expect(waiting).rejects.toThrow()
      expect(query.handle.listenerCount("heads-changed")).toBe(before)
    }
  )

  it("detaches its heads listener on abort", async () => {
    const query = readyQuery({ value: "v1" })
    const { heads } = future(query)
    const before = query.handle.listenerCount("heads-changed")
    const controller = new AbortController()
    const waiting = waitUntilReady(
      queryAtHeads(query, heads),
      controller.signal
    )
    controller.abort("stop")
    await expect(waiting).rejects.toBe("stop")
    expect(query.handle.listenerCount("heads-changed")).toBe(before)
  })
})

describe("queryAtPath", () => {
  it("yields a sub-handle once ready", () => {
    const query = readyQuery({ items: ["a"] })
    const state = queryAtPath(query, ["items"] as any).state()
    expect(state.state === "ready" && state.handle.doc()).toEqual(["a"])
  })

  it("maps subscribed states", () => {
    const query = createTestQuery<{ items: string[] }>(docId)
    query.handle.update(() => A.from({ items: ["a"] }))
    const states: QueryState<unknown>[] = []
    queryAtPath(query, ["items"] as any).subscribe(s => states.push(s))
    query.ready()
    expect(states).toHaveLength(2)
    expect(states[0]).toEqual({ state: "loading" })
    expect(states[1].state === "ready" && states[1].handle.doc()).toEqual(["a"])
  })
})

describe("toProgress", () => {
  it("synthesises the single backend source", () => {
    const query = createTestQuery(docId)
    const progress = toProgress(query)
    expect(progress.peek()).toEqual({
      state: "loading",
      sources: { backend: "pending" },
    })
    query.unavailable()
    expect(progress.peek().sources).toEqual({ backend: "unavailable" })
    query.ready()
    expect(progress.peek()).toMatchObject({
      state: "ready",
      sources: { backend: "ready" },
    })
  })

  it("reports deletion as failure and keeps whenReady", async () => {
    const query = createTestQuery(docId)
    const progress = toProgress(query)
    const waiting = progress.whenReady()
    query.deleted()
    expect(progress.peek()).toMatchObject({
      state: "failed",
      error: { message: expect.stringContaining("deleted") },
    })
    await expect(waiting).rejects.toThrow("deleted")
  })
})
