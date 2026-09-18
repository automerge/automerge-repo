import { afterEach, describe, expect, it, vi } from "vitest"
import { Observation, ReplayLog } from "../src/testing/ReplayLog.js"
import { expectPending, next, settled } from "./helpers.js"

describe("bounded ReplayLog implementation", () => {
  it("allocates strictly increasing positions and distinguishes waiting from lost history", () => {
    const log = new ReplayLog<number>(2, 100)
    expect(log.readAfter(0)).toEqual({ type: "wait" })
    expect(log.append(sequence => sequence * 10, 10)).toBe(1)
    expect(log.append(sequence => sequence * 10, 10)).toBe(2)
    expect(log.readAfter(0)).toEqual({ type: "entry", sequence: 1, value: 10 })
    expect(log.readAfter(1)).toEqual({ type: "entry", sequence: 2, value: 20 })
    log.append(sequence => sequence * 10, 10)
    expect(log.readAfter(0)).toEqual({ type: "behind" })
    expect(log.readAfter(1)).toEqual({ type: "entry", sequence: 2, value: 20 })
    expect(log.readAfter(3)).toEqual({ type: "wait" })
    log.clear()
    expect(log.readAfter(2)).toEqual({ type: "behind" })
    expect(log.readAfter(3)).toEqual({ type: "wait" })
    expect(log.append(sequence => sequence, 10)).toBe(4)
  })

  it("honors byte bounds independently of count, including a single oversized event", () => {
    const log = new ReplayLog<number>(100, 10)
    log.append(n => n, 4)
    log.append(n => n, 6)
    expect(log.readAfter(0).type).toBe("entry") // Exact budget retained.
    log.append(n => n, 1)
    expect(log.readAfter(0).type).toBe("behind")
    expect(log.readAfter(1)).toEqual({ type: "entry", sequence: 2, value: 2 })
    log.append(n => n, 11)
    expect(log.readAfter(3).type).toBe("behind")
    expect(log.readAfter(4).type).toBe("wait")
  })

  it("unsubscribe is idempotent and stops append notifications", () => {
    const log = new ReplayLog<number>(2, 100)
    const listener = vi.fn()
    const unsubscribe = log.subscribe(listener)
    log.append(n => n, 1)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    unsubscribe()
    log.append(n => n, 1)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("Observation resource release", () => {
  const cleanup: (() => void)[] = []
  afterEach(() => {
    cleanup.splice(0).forEach(close => close())
    vi.restoreAllMocks()
  })

  function setup(maxEvents = 2, initialValues: number[] = [10, 20]) {
    const log = new ReplayLog<number>(maxEvents, 100)
    const subscribe = log.subscribe.bind(log)
    const unsubscribe = vi.fn()
    vi.spyOn(log, "subscribe").mockImplementation(listener => {
      const stop = subscribe(listener)
      return () => {
        unsubscribe()
        stop()
      }
    })
    const source = initialValues[Symbol.iterator]()
    const returned = vi.fn(() => ({ done: true as const, value: undefined }))
    const initial: Iterator<number> = {
      next: () => source.next(),
      return: returned,
    }
    const released = vi.fn()
    const observation = new Observation(
      initial,
      log,
      value => value,
      () => -1,
      released
    )
    cleanup.push(() => observation.end())
    return { observation, log, returned, released, unsubscribe }
  }

  it.each(["return", "break", "end"])(
    "%s abandons initial enumeration and releases its listener exactly once",
    async method => {
      const { observation, returned, released, unsubscribe, log } = setup()
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
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      log.append(n => n, 1)
      expect((await settled(observation.next())).done).toBe(true)
    }
  )

  it.each(["return", "end"])(
    "%s settles an idle pending next and releases the listener",
    async method => {
      const { observation, released, unsubscribe } = setup(2, [])
      const pending = observation.next()
      await expectPending(pending)
      if (method === "return") await observation.return()
      else observation.end()
      expect((await settled(pending)).done).toBe(true)
      expect(released).toHaveBeenCalledTimes(1)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    }
  )

  it("invalidating terminal delivery replaces all unpulled snapshot/replay values and ends once", async () => {
    const { observation, log, returned, released } = setup()
    log.append(() => 30, 1)
    observation.end(99)
    observation.end(100)
    expect(await next(observation)).toBe(99)
    expect((await settled(observation.next())).done).toBe(true)
    expect(returned).toHaveBeenCalledTimes(1)
    expect(released).toHaveBeenCalledTimes(1)
  })

  it("terminal end also wakes an idle pending next; explicit return discards an unread terminal", async () => {
    const { observation } = setup(2, [])
    const pending = observation.next()
    observation.end(99)
    expect(await settled(pending)).toEqual({ done: false, value: 99 })
    expect((await settled(observation.next())).done).toBe(true)
    const unread = setup().observation
    unread.end(99)
    await unread.return()
    expect((await settled(unread.next())).done).toBe(true)
  })

  it("overflow releases interest immediately, emits rescan once and then ends", async () => {
    const { observation, log, released, unsubscribe } = setup(1, [])
    log.append(n => n, 1)
    log.append(n => n, 1)
    expect(await next(observation)).toBe(-1)
    expect(released).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect((await settled(observation.next())).done).toBe(true)
  })

  it("rejects a second outstanding next without losing the first waiter", async () => {
    const { observation, log } = setup(2, [])
    const first = observation.next()
    await expect(observation.next()).rejects.toThrow("one outstanding next")
    log.append(() => 42, 1)
    expect(await settled(first)).toEqual({ done: false, value: 42 })
  })
})
