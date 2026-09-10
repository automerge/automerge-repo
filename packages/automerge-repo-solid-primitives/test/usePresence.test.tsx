import { Repo } from "@automerge/automerge-repo"
import { render } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { usePresence, type UsePresenceResult } from "../src/usePresence.js"

type PresenceState = { status?: string }

type PresenceEnvelope = { __presence: { type: string } }

const isPresenceEnvelope = (msg: unknown): msg is PresenceEnvelope =>
  typeof msg === "object" && msg !== null && "__presence" in msg

const countHeartbeats = (calls: unknown[][]) =>
  calls.filter(([msg]) => {
    if (!isPresenceEnvelope(msg)) return false
    return msg.__presence.type === "heartbeat"
  }).length

const PresenceComponent = (props: {
  handle: ReturnType<Repo["create"]>
  userId: string
  initialState: PresenceState
  heartbeatMs?: number
  onReady?: (api: UsePresenceResult<PresenceState>) => void
}) => {
  const presence = usePresence<PresenceState>({
    handle: props.handle,
    userId: props.userId,
    initialState: props.initialState,
    heartbeatMs: props.heartbeatMs,
  })

  props.onReady?.(presence)

  return null
}

describe("usePresence", () => {
  it("switches heartbeat interval via stop/start", async () => {
    vi.useFakeTimers()

    const repo = new Repo()
    const handle = repo.create({})

    let api: UsePresenceResult<PresenceState> | undefined
    render(() => (
      <PresenceComponent
        handle={handle}
        userId="user1"
        initialState={{ status: "ready" }}
        heartbeatMs={50}
        onReady={value => {
          api = value
        }}
      />
    ))

    await Promise.resolve()

    expect(api).toBeDefined()

    const broadcastSpy = vi.spyOn(handle, "broadcast")

    vi.advanceTimersByTime(220)
    const slowCount = countHeartbeats(broadcastSpy.mock.calls)
    expect(slowCount).toBeGreaterThan(0)

    api?.stop()
    vi.advanceTimersByTime(220)
    expect(countHeartbeats(broadcastSpy.mock.calls)).toBe(slowCount)

    api?.start({ heartbeatMs: 10 })
    vi.advanceTimersByTime(220)
    const fastCount = countHeartbeats(broadcastSpy.mock.calls) - slowCount
    expect(fastCount).toBeGreaterThan(slowCount)

    vi.useRealTimers()
  })

  it("keeps heartbeat interval on restart without config", async () => {
    vi.useFakeTimers()

    const repo = new Repo()
    const handle = repo.create({})

    let api: UsePresenceResult<PresenceState> | undefined
    render(() => (
      <PresenceComponent
        handle={handle}
        userId="user1"
        initialState={{ status: "ready" }}
        heartbeatMs={15}
        onReady={value => {
          api = value
        }}
      />
    ))

    await Promise.resolve()

    expect(api).toBeDefined()

    const broadcastSpy = vi.spyOn(handle, "broadcast")

    vi.advanceTimersByTime(220)
    const initialCount = countHeartbeats(broadcastSpy.mock.calls)
    expect(initialCount).toBeGreaterThan(0)

    api?.stop()
    vi.advanceTimersByTime(220)
    const stoppedCount = countHeartbeats(broadcastSpy.mock.calls)
    expect(stoppedCount).toBe(initialCount)

    api?.start()
    vi.advanceTimersByTime(220)
    const resumedCount = countHeartbeats(broadcastSpy.mock.calls) - stoppedCount
    expect(resumedCount).toBeGreaterThan(0)
    expect(resumedCount).toBeGreaterThanOrEqual(initialCount - 2)
    expect(resumedCount).toBeLessThanOrEqual(initialCount + 2)

    vi.useRealTimers()
  })

  it("uses heartbeatMs from props", async () => {
    vi.useFakeTimers()

    const repo = new Repo()
    const handle = repo.create({})

    render(() => (
      <PresenceComponent
        handle={handle}
        userId="user1"
        initialState={{ status: "ready" }}
        heartbeatMs={20}
      />
    ))

    await Promise.resolve()

    const broadcastSpy = vi.spyOn(handle, "broadcast")

    vi.advanceTimersByTime(100)
    const count = countHeartbeats(broadcastSpy.mock.calls)
    expect(count).toBeGreaterThanOrEqual(5 - 2)
    expect(count).toBeLessThanOrEqual(5 + 2)

    vi.useRealTimers()
  })
})
