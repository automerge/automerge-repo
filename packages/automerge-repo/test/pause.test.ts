import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pause } from "../src/helpers/pause.js"
import { AbortError } from "../src/helpers/abortable.js"

describe("pause", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not resolve until the specified time has elapsed", async () => {
    let resolved = false
    const p = pause(40).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(39)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(resolved).toBe(true)
  })

  it("resolves after the specified time when a signal is provided but never aborts", async () => {
    const controller = new AbortController()
    let resolved = false
    const p = pause(40, { signal: controller.signal }).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(40)
    await p
    expect(resolved).toBe(true)
  })

  describe("signal support", () => {
    it("rejects synchronously without scheduling a timer when the signal is already aborted", async () => {
      const before = vi.getTimerCount()
      const controller = new AbortController()
      controller.abort()

      await expect(
        pause(1000, { signal: controller.signal })
      ).rejects.toBeInstanceOf(AbortError)
      // The abort fast-path returned before setTimeout was reached.
      expect(vi.getTimerCount()).toBe(before)
    })

    it("rejects with AbortError and clears the timer when the signal aborts mid-pause", async () => {
      const before = vi.getTimerCount()
      const controller = new AbortController()
      const p = pause(1000, { signal: controller.signal })
      expect(vi.getTimerCount()).toBe(before + 1)

      await vi.advanceTimersByTimeAsync(20)
      controller.abort()

      await expect(p).rejects.toBeInstanceOf(AbortError)
      // The pending 1000ms timer was cleared by the abort listener.
      expect(vi.getTimerCount()).toBe(before)
    })

    it("aborting after the pause already resolved does not throw or re-settle", async () => {
      const controller = new AbortController()
      const p = pause(10, { signal: controller.signal })
      await vi.advanceTimersByTimeAsync(10)
      await p
      // The timer fired and resolved; the listener should have been removed.
      // Either way, aborting now must be a harmless no-op.
      expect(() => controller.abort()).not.toThrow()
    })

    it("supports AbortSignal.any(): aborting any source signal cancels the pause", async () => {
      if (typeof AbortSignal.any !== "function") {
        // Runtime without AbortSignal.any (pre-Node-20 style); skip.
        return
      }
      const c1 = new AbortController()
      const c2 = new AbortController()
      const combined = AbortSignal.any([c1.signal, c2.signal])

      const p = pause(1000, { signal: combined })
      await vi.advanceTimersByTimeAsync(20)
      c2.abort() // abort via the second source

      await expect(p).rejects.toBeInstanceOf(AbortError)
    })
  })
})
