import { describe, it, expect, vi } from "vitest"
import {
  abortable,
  AbortError,
  isAbortErrorLike,
} from "../src/helpers/abortable.js"
import { pause } from "../src/helpers/pause.js"

describe("abortable", () => {
  describe("fast-path: signal already aborted before the call", () => {
    it("rejects immediately with signal.reason when signal was aborted with a custom reason", async () => {
      const controller = new AbortController()
      const customReason = new AbortError("custom abort reason")
      controller.abort(customReason)

      // Underlying promise never settles; if the fast-path weren't there,
      // the wrapper would depend on the abort-listener firing.
      const forever = new Promise<number>(() => {})
      await expect(abortable(forever, controller.signal)).rejects.toBe(
        customReason
      )
    })

    it("rejects immediately with the default reason when signal was aborted without one", async () => {
      const controller = new AbortController()
      controller.abort() // platform-default reason (an AbortError-like DOMException)

      const forever = new Promise<number>(() => {})
      const rejection = await abortable(forever, controller.signal).catch(
        e => e
      )
      expect(isAbortErrorLike(rejection)).toBe(true)
    })

    it("does not install an abort listener when the signal is already aborted", async () => {
      const controller = new AbortController()
      controller.abort()
      const addSpy = vi.spyOn(controller.signal, "addEventListener")

      await abortable(Promise.resolve(42), controller.signal).catch(() => {})

      expect(addSpy).not.toHaveBeenCalled()
    })
  })

  describe("listener cleanup after the wrapped promise settles", () => {
    it("removes the abort listener after the wrapped promise resolves", async () => {
      const controller = new AbortController()
      const addSpy = vi.spyOn(controller.signal, "addEventListener")
      const removeSpy = vi.spyOn(controller.signal, "removeEventListener")

      const result = await abortable(Promise.resolve(7), controller.signal)
      // The outer promise's resolve fires a few microtasks before the
      // .finally() cleanup runs; yield to let the whole chain drain.
      await pause(0)

      expect(result).toBe(7)
      expect(addSpy).toHaveBeenCalledTimes(1)
      expect(removeSpy).toHaveBeenCalledTimes(1)
      // The listener added and the listener removed must be the same function
      const [, addedFn] = addSpy.mock.calls[0]
      const [, removedFn] = removeSpy.mock.calls[0]
      expect(removedFn).toBe(addedFn)
    })

    it("removes the abort listener after the wrapped promise rejects", async () => {
      const controller = new AbortController()
      const addSpy = vi.spyOn(controller.signal, "addEventListener")
      const removeSpy = vi.spyOn(controller.signal, "removeEventListener")

      await expect(
        abortable(Promise.reject(new Error("boom")), controller.signal)
      ).rejects.toThrow("boom")
      await pause(0) // let the .finally() cleanup chain drain

      expect(addSpy).toHaveBeenCalledTimes(1)
      expect(removeSpy).toHaveBeenCalledTimes(1)
    })

    it("aborting the signal after settlement does not throw or produce an unhandled rejection", async () => {
      const controller = new AbortController()
      const value = await abortable(Promise.resolve("ok"), controller.signal)
      expect(value).toBe("ok")

      // Abort after the wrapper has already settled. The listener should
      // have been removed, and even if it hadn't, the `settled` flag in
      // abortable prevents a late reject. Either way, this must not throw.
      expect(() => controller.abort()).not.toThrow()
    })
  })

  describe("baseline behavior", () => {
    it("returns the resolved value when the wrapped promise resolves before abort", async () => {
      const controller = new AbortController()
      const result = await abortable(Promise.resolve(42), controller.signal)
      expect(result).toBe(42)
    })

    it("propagates the rejection when the wrapped promise rejects before abort", async () => {
      const controller = new AbortController()
      await expect(
        abortable(Promise.reject(new Error("inner")), controller.signal)
      ).rejects.toThrow("inner")
    })

    it("rejects with an AbortError-like error when signal aborts while the wrapped promise is pending", async () => {
      const controller = new AbortController()
      const pending = pause(1000) // slow enough to still be pending when we abort

      queueMicrotask(() => controller.abort())

      const rejection = await abortable(pending, controller.signal).catch(
        e => e
      )
      expect(isAbortErrorLike(rejection)).toBe(true)
    })

    it("passes through the wrapped promise unchanged when signal is undefined", async () => {
      const result = await abortable(Promise.resolve("no-signal"), undefined)
      expect(result).toBe("no-signal")

      await expect(
        abortable(Promise.reject(new Error("x")), undefined)
      ).rejects.toThrow("x")
    })
  })
})

describe("isAbortErrorLike", () => {
  describe("positive cases (returns true)", () => {
    it("recognizes an AbortError instance", () => {
      expect(isAbortErrorLike(new AbortError())).toBe(true)
      expect(isAbortErrorLike(new AbortError("custom message"))).toBe(true)
    })

    it("recognizes a DOMException whose name is 'AbortError'", () => {
      // This is what the platform produces for an aborted AbortSignal.reason
      // when abort() is called without arguments.
      const dom = new DOMException("aborted", "AbortError")
      expect(isAbortErrorLike(dom)).toBe(true)
    })

    it("recognizes a generic Error whose name is 'AbortError'", () => {
      // A duck-typed AbortError from some other library or ad-hoc code.
      const err = new Error("aborted")
      err.name = "AbortError"
      expect(isAbortErrorLike(err)).toBe(true)
    })

    it("recognizes the reason attached to an aborted AbortSignal", () => {
      const controller = new AbortController()
      controller.abort() // platform-default AbortError-like reason
      expect(isAbortErrorLike(controller.signal.reason)).toBe(true)
    })
  })

  describe("negative cases (returns false)", () => {
    it("rejects a plain Error (name='Error')", () => {
      expect(isAbortErrorLike(new Error("nope"))).toBe(false)
    })

    it("rejects other built-in error types", () => {
      expect(isAbortErrorLike(new TypeError("nope"))).toBe(false)
      expect(isAbortErrorLike(new RangeError("nope"))).toBe(false)
    })

    it("rejects a DOMException whose name is not 'AbortError'", () => {
      const dom = new DOMException("some other kind", "NotFoundError")
      expect(isAbortErrorLike(dom)).toBe(false)
    })

    it("rejects a plain object that merely has name='AbortError' (duck-typing is NOT enough)", () => {
      // Must be an Error/DOMException, not just any object with the right name.
      expect(isAbortErrorLike({ name: "AbortError", message: "x" })).toBe(false)
    })

    it("rejects null, undefined, and primitives", () => {
      expect(isAbortErrorLike(null)).toBe(false)
      expect(isAbortErrorLike(undefined)).toBe(false)
      expect(isAbortErrorLike("AbortError")).toBe(false)
      expect(isAbortErrorLike(42)).toBe(false)
      expect(isAbortErrorLike(false)).toBe(false)
    })
  })
})
