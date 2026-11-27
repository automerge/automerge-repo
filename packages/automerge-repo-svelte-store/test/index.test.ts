import { Repo } from "@automerge/automerge-repo"
import { get } from "svelte/store"
import { expect, it, vi } from "vitest"
import { createAutomergeStore, document } from "../src/lib/index.js"
import { counter, CounterHandle } from "./counter.js"

it("opens and creates documents of other doc types", async () => {
  const repo = new Repo()
  try {
    const stores = createAutomergeStore(repo)
    const store = await stores.create(0, { docType: counter })
    expect(store.handle).toBeInstanceOf(CounterHandle)
    expect(get(store)).toBe(0)
    await store.change(2)
    expect(get(store)).toBe(2)
    await store.handle.increment()
    expect(get(store)).toBe(3)

    const found = await stores.find(store.url, { docType: counter })
    expect(found?.handle).toBe(store.handle)
    const viaDocument = await document(store.url, { docType: counter, repo })
    expect(viaDocument?.handle).toBe(store.handle)
    await expect(document(store.url as any, repo)).rejects.toThrow()
    const todo = await stores.create({ title: "x" })
    expect((await document(todo.url, { repo }))?.handle).toBe(todo.handle)
  } finally {
    await repo.shutdown()
  }
})

it("wraps async creation and lookup, preserving immediate edits and persistence errors", async () => {
  const repo = new Repo()
  try {
    const stores = createAutomergeStore(repo)
    const store = await stores.create({ count: 0 })
    const found = await stores.find<{ count: number }>(store.url)
    expect(found?.handle).toBe(store.handle)

    const persistence = store.change(doc => doc.count++)
    expect(get(store)?.count).toBe(1)
    expect(persistence).toBeInstanceOf(Promise)
    await persistence

    const error = new Error("Persistence failed")
    vi.spyOn(store.handle, "change").mockImplementationOnce(() =>
      Promise.reject(error)
    )
    await expect(store.change(() => {})).rejects.toBe(error)
  } finally {
    await repo.shutdown()
  }
})

it("attaches the change listener on subscribe and detaches when unsubscribed", async () => {
  const repo = new Repo()
  try {
    const stores = createAutomergeStore(repo)
    const store = await stores.create({ count: 0 })
    expect(store.handle.listenerCount("change")).toBe(0)

    const seen: number[] = []
    const unsub1 = store.subscribe(doc => {
      if (doc) seen.push(doc.count)
    })
    const unsub2 = store.subscribe(() => {})
    expect(store.handle.listenerCount("change")).toBe(1)

    await store.change(doc => {
      doc.count = 1
    })
    expect(seen).toEqual([0, 1])

    unsub1()
    expect(store.handle.listenerCount("change")).toBe(1)
    unsub2()
    expect(store.handle.listenerCount("change")).toBe(0)

    // Changes while unsubscribed are picked up on the next subscription.
    await store.change(doc => {
      doc.count = 2
    })
    const after: number[] = []
    const unsub3 = store.subscribe(doc => {
      if (doc) after.push(doc.count)
    })
    expect(after).toEqual([2])
    expect(store.handle.listenerCount("change")).toBe(1)
    unsub3()
    expect(store.handle.listenerCount("change")).toBe(0)
  } finally {
    await repo.shutdown()
  }
})
