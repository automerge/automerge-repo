import { describe, it, expect } from "vitest"
import { rejectOnFailure } from "../src/index.js"

// rejectOnFailure only reads `.error` and assigns the `onerror` / `onabort`
// handlers, so plain objects stand in for the transaction and request. This
// keeps the test off both a real IndexedDB and the adapter's private state.
function wire() {
  const request: any = {}
  const transaction: any = {}
  const reasons: unknown[] = []
  rejectOnFailure(transaction, request, reason => reasons.push(reason))
  return { request, transaction, reasons }
}

describe("rejectOnFailure", () => {
  it("wires the request error, transaction error, and transaction abort", () => {
    const { request, transaction } = wire()
    expect(typeof request.onerror).toBe("function")
    expect(typeof transaction.onerror).toBe("function")
    expect(typeof transaction.onabort).toBe("function")
  })

  it("rejects with the request error on a request-level failure", () => {
    const { request, reasons } = wire()
    const err = new DOMException("constraint", "ConstraintError")
    request.error = err
    request.onerror()
    expect(reasons[0]).toBe(err)
  })

  it("rejects with the transaction error when the request error is null", () => {
    // A transaction-level failure (e.g. quota) sets transaction.error while the
    // request error stays null.
    const { request, transaction, reasons } = wire()
    const quota = new DOMException("quota exceeded", "QuotaExceededError")
    transaction.error = quota
    request.error = null
    transaction.onerror()
    expect(reasons[0]).toBe(quota)
  })

  it("rejects when the transaction aborts", () => {
    const { transaction, reasons } = wire()
    const aborted = new DOMException("aborted", "AbortError")
    transaction.error = aborted
    transaction.onabort()
    expect(reasons[0]).toBe(aborted)
  })

  it("rejects with a generic error when neither source has a reason", () => {
    // e.g. an explicit transaction.abort(), where transaction.error is null.
    const { transaction, reasons } = wire()
    transaction.onabort()
    expect(reasons[0]).toBeInstanceOf(Error)
  })
})
