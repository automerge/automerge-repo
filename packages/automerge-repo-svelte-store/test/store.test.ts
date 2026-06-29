import { Repo } from "@automerge/automerge-repo"
import { describe, expect, it } from "vitest"
import { createAutomergeStore } from "../src/lib/index.js"

type Counter = { count: number }

describe("createAutomergeStore", () => {
  it("attaches a change listener only while the store has subscribers", async () => {
    const repo = new Repo({})
    const handle = repo.create<Counter>({ count: 0 })
    const docStore = await createAutomergeStore(repo).find<Counter>(handle.url)
    expect(docStore).not.toBeNull()

    // Measure relative to the baseline: other subsystems (e.g. the
    // DocSynchronizer) also attach "change" listeners, so assert on the delta
    // the store contributes rather than an absolute count.
    const base = docStore!.handle.listenerCount("change")

    const unsub1 = docStore!.subscribe(() => {})
    expect(docStore!.handle.listenerCount("change")).toBe(base + 1)

    // Svelte refcounts subscribers: a second subscriber does not add a second
    // handle listener.
    const unsub2 = docStore!.subscribe(() => {})
    expect(docStore!.handle.listenerCount("change")).toBe(base + 1)

    unsub1()
    expect(docStore!.handle.listenerCount("change")).toBe(base + 1)

    // Last subscriber gone -> the store's handle listener is removed.
    unsub2()
    expect(docStore!.handle.listenerCount("change")).toBe(base)
  })

  it("reflects document changes while subscribed", async () => {
    const repo = new Repo({})
    const handle = repo.create<Counter>({ count: 0 })
    const docStore = await createAutomergeStore(repo).find<Counter>(handle.url)

    let latest: Counter | null = null
    const unsub = docStore!.subscribe(value => {
      latest = value
    })
    expect(latest!.count).toBe(0)

    docStore!.change(d => {
      d.count = 5
    })
    expect(latest!.count).toBe(5)

    unsub()
  })
})
