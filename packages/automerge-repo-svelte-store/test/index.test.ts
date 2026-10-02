import { Repo } from "@automerge/automerge-repo"
import { get } from "svelte/store"
import { expect, it, vi } from "vitest"
import { createAutomergeStore } from "../src/lib/index.js"

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
