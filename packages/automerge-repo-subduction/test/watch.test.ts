import { describe, expect, it, vi } from "vitest"
import { Watch } from "../src/watch.js"

function buffer(events = 2, bytes = 100) {
  const released = vi.fn()
  const watch = new Watch<string>(
    events,
    bytes,
    value => value,
    () => "rescan",
    released
  )
  watch.initialize([])
  return { watch, released }
}

describe("lossy observation buffering", () => {
  it("drops ephemerals on event overflow without closing the watch", async () => {
    const { watch, released } = buffer(1)
    watch.push("first", 10, true)
    watch.push("dropped", 10, true)
    expect((await watch.next()).value).toBe("first")
    expect(watch.active).toBe(true)
    expect(released).not.toHaveBeenCalled()
    await watch.return()
  })

  it("drops oversized ephemerals without discarding the initial cut", async () => {
    const { watch, released } = buffer(1, 10)
    watch.initialize(["initial"])
    watch.push("oversized", 11, true)
    watch.push("durable", 10)
    expect((await watch.next()).value).toBe("initial")
    expect((await watch.next()).value).toBe("durable")
    expect(released).not.toHaveBeenCalled()
    await watch.return()
  })

  it("evicts only ephemerals to make room for durable events", async () => {
    const { watch } = buffer(3, 100)
    watch.push("durable-first", 30)
    watch.push("lossy-first", 30, true)
    watch.push("lossy-second", 30, true)
    watch.push("durable-last", 60)
    expect((await watch.next()).value).toBe("durable-first")
    expect((await watch.next()).value).toBe("durable-last")
    expect(watch.active).toBe(true)
    await watch.return()
  })

  it("accounts for bytes after eviction and consumption", async () => {
    const { watch, released } = buffer(2, 10)
    watch.push("lossy", 10, true)
    watch.push("durable", 8)
    expect((await watch.next()).value).toBe("durable")
    watch.push("next", 10)
    expect((await watch.next()).value).toBe("next")
    expect(released).not.toHaveBeenCalled()
    await watch.return()
  })

  it("retains rescan behavior for genuine durable overflow", async () => {
    const { watch, released } = buffer(1, 10)
    watch.push("durable", 10)
    watch.push("lossy", 1, true)
    watch.push("overflow", 1)
    expect((await watch.next()).value).toBe("rescan")
    expect((await watch.next()).done).toBe(true)
    expect(released).toHaveBeenCalledOnce()
  })

  it("wakes pending pulls and does not resurrect released watches", async () => {
    const { watch } = buffer()
    const pending = watch.next()
    watch.push("lossy", 1, true)
    expect((await pending).value).toBe("lossy")
    await watch.return()
    watch.push("late", 1, true)
    expect((await watch.next()).done).toBe(true)
  })
})
