import {
  Presence,
  type PeerId,
  type PresenceHandle,
  type PresenceInbound,
  type RepoId,
} from "@automerge/automerge-repo"
import { render } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePresence, type UsePresenceResult } from "../src/index.js"

type PresenceState = { status?: string }

type PresenceEnvelope = { __presence: { type: string } }

/** Stands in for a handle with ephemeral messaging; `receive` delivers a
 * peer's message. */
class FakePresenceHandle implements PresenceHandle {
  readonly #listeners = new Set<(payload: PresenceInbound) => void>()

  broadcast(_message: unknown): void {}

  on(_event: "ephemeral-message", fn: (payload: PresenceInbound) => void) {
    this.#listeners.add(fn)
  }

  off(_event: "ephemeral-message", fn?: (payload: PresenceInbound) => void) {
    if (fn) this.#listeners.delete(fn)
    else this.#listeners.clear()
  }

  receive(originId: string, message: Record<string, unknown>) {
    for (const fn of [...this.#listeners])
      fn({
        senderId: originId as PeerId,
        originId: originId as RepoId,
        message: { __presence: message },
      })
  }
}

const isPresenceEnvelope = (msg: unknown): msg is PresenceEnvelope =>
  typeof msg === "object" && msg !== null && "__presence" in msg

const countHeartbeats = (calls: unknown[][]) =>
  calls.filter(([msg]) => {
    if (!isPresenceEnvelope(msg)) return false
    return msg.__presence.type === "heartbeat"
  }).length

const renderPresence = (
  handle: PresenceHandle,
  options: { heartbeatMs?: number; peerTtlMs?: number } = {}
) => {
  let api: UsePresenceResult<PresenceState> | undefined
  render(() => {
    api = usePresence<PresenceState>({
      handle,
      initialState: { status: "ready" },
      ...options,
    })
    return null
  })
  expect(api).toBeDefined()
  return api!
}

describe("usePresence", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("switches heartbeat interval via stop/start", () => {
    const handle = new FakePresenceHandle()
    const api = renderPresence(handle, { heartbeatMs: 50 })
    const broadcastSpy = vi.spyOn(handle, "broadcast")

    vi.advanceTimersByTime(220)
    const slowCount = countHeartbeats(broadcastSpy.mock.calls)
    expect(slowCount).toBeGreaterThan(0)

    api.stop()
    vi.advanceTimersByTime(220)
    expect(countHeartbeats(broadcastSpy.mock.calls)).toBe(slowCount)

    api.start({ heartbeatMs: 10 })
    vi.advanceTimersByTime(220)
    const fastCount = countHeartbeats(broadcastSpy.mock.calls) - slowCount
    expect(fastCount).toBeGreaterThan(slowCount)
  })

  it("keeps heartbeat interval on restart without config", () => {
    const handle = new FakePresenceHandle()
    const api = renderPresence(handle, { heartbeatMs: 15 })
    const broadcastSpy = vi.spyOn(handle, "broadcast")

    vi.advanceTimersByTime(220)
    const initialCount = countHeartbeats(broadcastSpy.mock.calls)
    expect(initialCount).toBeGreaterThan(0)

    api.stop()
    vi.advanceTimersByTime(220)
    const stoppedCount = countHeartbeats(broadcastSpy.mock.calls)
    expect(stoppedCount).toBe(initialCount)

    api.start()
    vi.advanceTimersByTime(220)
    const resumedCount = countHeartbeats(broadcastSpy.mock.calls) - stoppedCount
    expect(resumedCount).toBeGreaterThan(0)
    expect(resumedCount).toBeGreaterThanOrEqual(initialCount - 2)
    expect(resumedCount).toBeLessThanOrEqual(initialCount + 2)
  })

  it("uses heartbeatMs from props", () => {
    const handle = new FakePresenceHandle()
    renderPresence(handle, { heartbeatMs: 20 })
    const broadcastSpy = vi.spyOn(handle, "broadcast")

    vi.advanceTimersByTime(100)
    const count = countHeartbeats(broadcastSpy.mock.calls)
    expect(count).toBeGreaterThanOrEqual(5 - 2)
    expect(count).toBeLessThanOrEqual(5 + 2)
  })

  it("does not add listeners on restart and still tracks peers", () => {
    const on = vi.spyOn(Presence.prototype, "on")
    const handle = new FakePresenceHandle()
    const api = renderPresence(handle)
    const attached = on.mock.calls.length

    api.stop()
    api.start()
    api.stop()
    api.start()
    expect(on.mock.calls.length).toBe(attached)

    handle.receive("peer-1", { type: "snapshot", state: { status: "here" } })
    expect(api.peerStates.value["peer-1" as RepoId]?.value).toEqual({
      status: "here",
    })
  })

  it("drops a peer that times out without saying goodbye", () => {
    const handle = new FakePresenceHandle()
    const api = renderPresence(handle, { heartbeatMs: 10, peerTtlMs: 50 })

    handle.receive("peer-1", { type: "snapshot", state: { status: "here" } })
    expect(Object.keys(api.peerStates.value)).toEqual(["peer-1"])

    vi.advanceTimersByTime(100)
    expect(Object.keys(api.peerStates.value)).toEqual([])
  })
})
