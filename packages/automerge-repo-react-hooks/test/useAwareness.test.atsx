import { renderHook } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { RepoContext, useRepo } from "../src/useRepo.js"
import { Repo } from "@automerge/automerge-repo"
import React from "react"

describe("use{Local,Remote}Awareness", () => {
  test("it should allow a user to create a local awareness", () => {
    const repo = new Repo({ network: [] })
    // Prevent console spam by swallowing console.error "uncaught error" message
    const spy = vi.spyOn(console, "error")
    spy.mockImplementation(() => {})
    expect(() => renderHook(() => useRepo())).toThrow(
      /Repo was not found on RepoContext/
    )
    spy.mockRestore()
  })
})

// basic send/receive
// it should allow a user to set a local awareness
// it should not notify the local peer when they set a local awareness
// it should return another peer's awareness when it gets set remotely
// heartbeats & timeouts
// it should remove a peer that hasn't sent an update since the heartbeat timeout
// it should send a heartbeat at an configurable interval
// multiple docs
// it shouldn't receive awareness across docs
// multiple clients with awareness
// when there are more than one client with the same userid it shouldn't compete for the same awareness
// if a user has two clients, the value should be the last one set by the user (most recent wins)
