import { describe, it, expect } from "vitest"
import { rejectOnTransactionFailure } from "../src/index.js"

// rejectOnTransactionFailure only reads `.error` (from the failing event's
// target and from the transaction) and assigns onerror/onabort, so plain
// objects stand in for the transaction and the failing request. This keeps the
// test off both a real IndexedDB and the adapter's private state.
function wire() {
  const transaction: any = {}
  const reasons: unknown[] = []
  rejectOnTransactionFailure(transaction, reason => reasons.push(reason))
  return { transaction, reasons }
}

describe("rejectOnTransactionFailure", () => {
  it("wires the transaction error and abort handlers", () => {
    const { transaction } = wire()
    expect(typeof transaction.onerror).toBe("function")
    expect(typeof transaction.onabort).toBe("function")
  })

  it("surfaces the failing request's specific error via the event target", () => {
    // A request-level failure (e.g. a put hitting quota) bubbles to
    // transaction.onerror with the failing request as event.target and its
    // .error set, while transaction.error is still null at this point.
    const { transaction, reasons } = wire()
    const quota = new DOMException("quota exceeded", "QuotaExceededError")
    transaction.error = null
    transaction.onerror({ target: { error: quota } })
    expect(reasons[0]).toBe(quota)
  })

  it("falls back to the transaction error when the failing request has none", () => {
    // A transaction-level failure can fire onerror while the target request's
    // .error is still null; the reason then comes from transaction.error.
    const { transaction, reasons } = wire()
    const aborted = new DOMException("aborted", "AbortError")
    transaction.error = aborted
    transaction.onerror({ target: { error: null } })
    expect(reasons[0]).toBe(aborted)
  })

  it("rejects with a generic error when neither source has a reason", () => {
    // e.g. an explicit transaction.abort() with no set error.
    const { transaction, reasons } = wire()
    transaction.onabort({ target: transaction })
    expect(reasons[0]).toBeInstanceOf(Error)
  })
})
