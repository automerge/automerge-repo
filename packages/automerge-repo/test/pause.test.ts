import { describe, it, expect } from "vitest"
import { pause } from "../src/helpers/pause.js"
import { AbortError } from "../src/helpers/abortable.js"

describe("pause", () => {
  it("resolves after approximately the specified time when no signal is passed", async () => {
    const start = Date.now()
    await pause(40)
    expect(Date.now() - start).toBeGreaterThanOrEqual(35) // allow small timer drift
  })

  it("resolves normally when a signal is provided but never aborts", async () => {
    const controller = new AbortController()
    const start = Date.now()
    await pause(40, { signal: controller.signal })
    expect(Date.now() - start).toBeGreaterThanOrEqual(35)
  })

  describe("signal support", () => {
    it("rejects immediately with AbortError when the signal is already aborted", async () => {
      const controller = new AbortController()
      controller.abort()

      const start = Date.now()
      await expect(
        pause(1000, { signal: controller.signal })
      ).rejects.toBeInstanceOf(AbortError)
      // Fast-path: reject without waiting for the 1000ms timer.
      expect(Date.now() - start).toBeLessThan(50)
    })

    it("rejects with AbortError shortly after the signal aborts mid-pause", async () => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 20)

      const start = Date.now()
      await expect(
        pause(1000, { signal: controller.signal })
      ).rejects.toBeInstanceOf(AbortError)
      // Rejected near T=20 (abort time), not near T=1000 (original timeout).
      // Proves the abort listener fired and clearTimeout prevented the late resolve.
      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(15)
      expect(elapsed).toBeLessThan(200)
    })

    it("aborting after the pause already resolved does not throw or re-settle", async () => {
      const controller = new AbortController()
      await pause(10, { signal: controller.signal })
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

      setTimeout(() => c2.abort(), 20) // abort via the second source

      const start = Date.now()
      await expect(pause(1000, { signal: combined })).rejects.toBeInstanceOf(
        AbortError
      )
      expect(Date.now() - start).toBeLessThan(200)
    })
  })
})
