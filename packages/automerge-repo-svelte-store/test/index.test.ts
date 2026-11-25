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
