import { describe, expect, it } from "vitest"
import { NetworkAdapter } from "../src/index.js"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter.js"

// Flush microtasks (via a macrotask hop) so the constructor's deferred
// readiness wiring has settled before asserting on state.
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** A NetworkAdapter whose whenReady() rejects, i.e. it never becomes ready. */
class RejectingNetworkAdapter extends NetworkAdapter {
  isReady() {
    return false
  }
  whenReady() {
    return Promise.reject(new Error("adapter failed to become ready"))
  }
  connect() {}
  send() {}
  disconnect() {}
}

describe("NetworkAdapter", () => {
  it("stays connecting and surfaces no unhandled rejection when whenReady() rejects", async () => {
    const unhandled: unknown[] = []
    const capture = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", capture)
    try {
      const adapter = new RejectingNetworkAdapter()
      await settle()
      expect(adapter.state().value).toBe("connecting")
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", capture)
    }
  })

  it("transitions to ready when whenReady() resolves", async () => {
    const adapter = new DummyNetworkAdapter({ startReady: true })
    await settle()
    expect(adapter.state().value).toBe("ready")
  })
})
