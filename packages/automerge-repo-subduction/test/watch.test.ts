import { describe, expect, it, vi } from "vitest"
import { Watch } from "../src/watch.js"

function queue() {
  const released = vi.fn()
  const watch = new Watch<string>(released)
  watch.initialize([])
  return { watch, released }
}

describe("observation queue", () => {
  it("buffers pre-initialization updates behind the initial batch", async () => {
    const watch = new Watch<string>(vi.fn())
    watch.push("live")
    expect(watch.active).toBe(false)
    watch.initialize(["initial", "complete"])
    expect((await watch.next()).value).toBe("initial")
    expect((await watch.next()).value).toBe("complete")
    expect((await watch.next()).value).toBe("live")
    await watch.return()
  })

  it("delivers initial-load events as they arrive, ahead of held live updates", async () => {
    const watch = new Watch<string>(vi.fn())
    watch.push("live")
    const pending = watch.next()
    watch.pushInitial("blob 1")
    expect((await pending).value).toBe("blob 1")
    watch.pushInitial("blob 2")
    expect((await watch.next()).value).toBe("blob 2")
    const held = watch.next()
    watch.initialize(["complete"])
    expect((await held).value).toBe("complete")
    expect((await watch.next()).value).toBe("live")
    await watch.return()
  })

  it("wakes pending pulls and does not resurrect released watches", async () => {
    const { watch } = queue()
    const pending = watch.next()
    watch.push("first")
    expect((await pending).value).toBe("first")
    await watch.return()
    watch.push("late")
    expect((await watch.next()).done).toBe(true)
  })
})
