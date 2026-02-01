import { Repo } from "@automerge/automerge-repo"
import { render } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { usePresence } from "../src/usePresence.js"
import { PRESENCE_MESSAGE_MARKER } from "../../automerge-repo/dist/presence/constants.js"
import { PresenceMessage } from "../../automerge-repo/dist/presence/types.js"

const isPresenceMessage = (msg: unknown): msg is PresenceMessage =>
  typeof msg === "object" && msg !== null && PRESENCE_MESSAGE_MARKER in msg

describe("usePresence", () => {
  it("changes heartbeat frequency after stop/start", async () => {
    vi.useFakeTimers()

    const repo = new Repo()
    const handle = repo.create({})

    let api: ReturnType<typeof usePresence>
    const Component = () => {
      api = usePresence({
        handle,
        userId: "alice",
        initialState: {},
        heartbeatMs: 50,
      })
      return null
    }

    render(() => <Component />)

    await Promise.resolve() // allow onMount

    const broadcastSpy = vi.spyOn(handle, "broadcast")
    const heartbeatCount = () =>
      broadcastSpy.mock.calls.filter(([msg]) => {
        if (!isPresenceMessage(msg)) return false
        return msg[PRESENCE_MESSAGE_MARKER].type === "heartbeat"
      }).length

    vi.advanceTimersByTime(220)
    const slowCount = heartbeatCount()
    expect(slowCount).toBeGreaterThan(0)

    api!.stop()
    vi.advanceTimersByTime(220)
    expect(heartbeatCount()).toBe(slowCount)

    api!.start({ heartbeatMs: 10 })
    vi.advanceTimersByTime(220)
    const fastCount = heartbeatCount() - slowCount
    expect(fastCount).toBeGreaterThan(slowCount)

    vi.useRealTimers()
  })
})
