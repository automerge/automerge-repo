import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KeepAlive } from "../src/helpers/KeepAlive.js"

describe("KeepAlive", () => {
  const PERIOD = 1000
  const a = { name: "a" }
  const b = { name: "b" }
  const held = (keepAlive: KeepAlive<object>) =>
    Array.from(keepAlive.leastRecentFirst())

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("holds an item for one to two periods after its last touch", () => {
    const keepAlive = new KeepAlive<object>(PERIOD)
    keepAlive.touch(a)

    vi.advanceTimersByTime(PERIOD)
    expect(held(keepAlive)).toEqual([a])

    vi.advanceTimersByTime(PERIOD)
    expect(held(keepAlive)).toEqual([])
  })

  it("a touch restarts the item's period", () => {
    const keepAlive = new KeepAlive<object>(PERIOD)
    keepAlive.touch(a)
    vi.advanceTimersByTime(PERIOD)
    keepAlive.touch(a)

    vi.advanceTimersByTime(PERIOD)
    expect(held(keepAlive)).toEqual([a])

    vi.advanceTimersByTime(PERIOD)
    expect(held(keepAlive)).toEqual([])
  })

  it("lists items least recently touched first", () => {
    const keepAlive = new KeepAlive<object>(PERIOD)
    keepAlive.touch(a)
    keepAlive.touch(b)
    expect(held(keepAlive)).toEqual([a, b])

    keepAlive.touch(a)
    expect(held(keepAlive)).toEqual([b, a])

    vi.advanceTimersByTime(PERIOD)
    keepAlive.touch(b)
    expect(held(keepAlive)).toEqual([a, b])
  })

  it("stops its timer once nothing is held", () => {
    const keepAlive = new KeepAlive<object>(PERIOD)
    keepAlive.touch(a)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(PERIOD * 3)
    expect(vi.getTimerCount()).toBe(0)

    keepAlive.touch(b)
    expect(vi.getTimerCount()).toBe(1)
  })

  it("delete and clear release at once", () => {
    const keepAlive = new KeepAlive<object>(PERIOD)
    keepAlive.touch(a)
    keepAlive.touch(b)

    keepAlive.delete(a)
    expect(held(keepAlive)).toEqual([b])

    keepAlive.clear()
    expect(held(keepAlive)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("with an infinite period, holds items until deleted and runs no timer", () => {
    const keepAlive = new KeepAlive<object>(Infinity)
    keepAlive.touch(a)
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(PERIOD * 1000)
    expect(held(keepAlive)).toEqual([a])

    keepAlive.delete(a)
    expect(held(keepAlive)).toEqual([])
  })

  it("tracks sizes and trims the least recently touched first", () => {
    const keepAlive = new KeepAlive<object>(PERIOD)
    const c = { name: "c" }
    keepAlive.touch(a, 10)
    keepAlive.touch(b, 20)
    keepAlive.touch(c, 30)
    expect(keepAlive.totalSize).toBe(60)

    keepAlive.resize(a, 15)
    expect(keepAlive.totalSize).toBe(65)

    keepAlive.touch(a, 15)
    keepAlive.trimTo(45)
    expect(held(keepAlive)).toEqual([c, a])
    expect(keepAlive.totalSize).toBe(45)
  })

  it("subtracts the sizes of released items", () => {
    const keepAlive = new KeepAlive<object>(PERIOD)
    keepAlive.touch(a, 10)
    vi.advanceTimersByTime(PERIOD)
    keepAlive.touch(b, 20)
    expect(keepAlive.totalSize).toBe(30)

    vi.advanceTimersByTime(PERIOD)
    expect(keepAlive.totalSize).toBe(20)

    keepAlive.delete(b)
    expect(keepAlive.totalSize).toBe(0)
  })
})
