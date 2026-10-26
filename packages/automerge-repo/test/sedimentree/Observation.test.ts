// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { Observation } from "../helpers/Observation.js"
import { expectPending, next, settled } from "./helpers.js"

describe("Observation resource release", () => {
  const cleanup: (() => void)[] = []
  afterEach(() => {
    cleanup.splice(0).forEach(close => close())
    vi.restoreAllMocks()
  })

  function setup(initialValues: number[] = [10, 20]) {
    const source = initialValues[Symbol.iterator]()
    const returned = vi.fn(() => ({ done: true as const, value: undefined }))
    const initial: Iterator<number> = {
      next: () => source.next(),
      return: returned,
    }
    const released = vi.fn()
    const observation = new Observation(initial, value => value, released)
    cleanup.push(() => observation.end())
    return { observation, returned, released }
  }

  it("delivers the initial cut, then live values in push order", async () => {
    const { observation } = setup()
    observation.push(30)
    observation.push(40)
    expect(await next(observation)).toBe(10)
    expect(await next(observation)).toBe(20)
    expect(await next(observation)).toBe(30)
    expect(await next(observation)).toBe(40)
    const pending = observation.next()
    await expectPending(pending)
    observation.push(50)
    expect(await settled(pending)).toEqual({ done: false, value: 50 })
  })

  it.each(["return", "break", "end"])(
    "%s abandons initial enumeration and releases exactly once",
    async method => {
      const { observation, returned, released } = setup()
      if (method === "return") await observation.return()
      else if (method === "end") observation.end()
      else
        for await (const value of observation) {
          expect(value).toBe(10)
          break
        }
      observation.end()
      await observation.return()
      expect(returned).toHaveBeenCalledTimes(1)
      expect(released).toHaveBeenCalledTimes(1)
      observation.push(1)
      expect((await settled(observation.next())).done).toBe(true)
    }
  )

  it.each(["return", "end"])(
    "%s settles an idle pending next and releases",
    async method => {
      const { observation, released } = setup([])
      const pending = observation.next()
      await expectPending(pending)
      if (method === "return") await observation.return()
      else observation.end()
      expect((await settled(pending)).done).toBe(true)
      expect(released).toHaveBeenCalledTimes(1)
    }
  )

  it("invalidating terminal delivery replaces all unpulled snapshot/live values and ends once", async () => {
    const { observation, returned, released } = setup()
    observation.push(30)
    observation.end(99)
    observation.end(100)
    expect(await next(observation)).toBe(99)
    expect((await settled(observation.next())).done).toBe(true)
    expect(returned).toHaveBeenCalledTimes(1)
    expect(released).toHaveBeenCalledTimes(1)
  })

  it("terminal end also wakes an idle pending next; explicit return discards an unread terminal", async () => {
    const { observation } = setup([])
    const pending = observation.next()
    observation.end(99)
    expect(await settled(pending)).toEqual({ done: false, value: 99 })
    expect((await settled(observation.next())).done).toBe(true)
    const unread = setup().observation
    unread.end(99)
    await unread.return()
    expect((await settled(unread.next())).done).toBe(true)
  })

  it("rejects a second outstanding next without losing the first waiter", async () => {
    const { observation } = setup([])
    const first = observation.next()
    await expect(observation.next()).rejects.toThrow("one outstanding next")
    observation.push(42)
    expect(await settled(first)).toEqual({ done: false, value: 42 })
  })
})
