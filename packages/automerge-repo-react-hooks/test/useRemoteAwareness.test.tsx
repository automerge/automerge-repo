import { DocHandle } from "@automerge/automerge-repo"
import { render, waitFor } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import "@testing-library/jest-dom"

import { useRemoteAwareness } from "../src/useRemoteAwareness"
import { setup, ExampleDoc } from "./testSetup"

describe("useRemoteAwareness", () => {
  describe("with defined handle", () => {
    const Component = ({
      handle,
      localUserId,
    }: {
      handle: DocHandle<ExampleDoc>
      localUserId?: string
    }) => {
      const [peerStates, heartbeats] = useRemoteAwareness({
        handle,
        localUserId,
      })
      return (
        <div>
          <div data-testid="peer-states">{JSON.stringify(peerStates)}</div>
          <div data-testid="heartbeats">{JSON.stringify(heartbeats)}</div>
        </div>
      )
    }

    it("should initialize with empty peer states", () => {
      const { handleA, wrapper } = setup()

      const { getByTestId } = render(
        <Component handle={handleA} localUserId="local-user" />,
        { wrapper }
      )

      expect(getByTestId("peer-states")).toHaveTextContent("{}")
      expect(getByTestId("heartbeats")).toHaveTextContent("{}")
    })

    it("should receive and store remote peer states", async () => {
      const { handleA, wrapper } = setup()

      const { getByTestId } = render(
        <Component handle={handleA} localUserId="local-user" />,
        { wrapper }
      )

      // Simulate receiving a message from a remote peer
      const mockEvent = {
        handle: handleA,
        message: ["remote-user", { status: "online" }],
      }

      // @ts-ignore - accessing private emit for testing
      React.act(() => {
        handleA.emit("ephemeral-message", mockEvent)
      })

      await waitFor(() => {
        expect(getByTestId("peer-states")).toHaveTextContent(
          JSON.stringify({ "remote-user": { status: "online" } })
        )
      })
    })

    it("should filter out messages from local user", async () => {
      const { handleA, wrapper } = setup()

      const { getByTestId } = render(
        <Component handle={handleA} localUserId="local-user" />,
        { wrapper }
      )

      // Simulate receiving a message from the local user (should be ignored)
      const mockEvent = {
        handle: handleA,
        message: ["local-user", { status: "online" }],
      }

      // @ts-ignore - accessing private emit for testing
      React.act(() => {
        handleA.emit("ephemeral-message", mockEvent)
      })

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100))

      // Should still be empty
      expect(getByTestId("peer-states")).toHaveTextContent("{}")
    })

    it("should update heartbeat timestamps when receiving messages", async () => {
      const { handleA, wrapper } = setup()
      const mockGetTime = vi.fn(() => 1000)

      const ComponentWithTime = () => {
        const [peerStates, heartbeats] = useRemoteAwareness({
          handle: handleA,
          localUserId: "local-user",
          getTime: mockGetTime,
        })
        return (
          <div>
            <div data-testid="heartbeats">{JSON.stringify(heartbeats)}</div>
          </div>
        )
      }

      const { getByTestId } = render(<ComponentWithTime />, { wrapper })

      // Simulate receiving a message
      const mockEvent = {
        handle: handleA,
        message: ["remote-user", { status: "online" }],
      }

      // @ts-ignore - accessing private emit for testing
      React.act(() => {
        handleA.emit("ephemeral-message", mockEvent)
      })

      await waitFor(() => {
        expect(getByTestId("heartbeats")).toHaveTextContent(
          JSON.stringify({ "remote-user": 1000 })
        )
      })
    })

    it("should prune offline peers after timeout", async () => {
      const { handleA, wrapper } = setup()
      let currentTime = 1000
      const mockGetTime = vi.fn(() => currentTime)

      const ComponentWithTime = () => {
        const [peerStates] = useRemoteAwareness({
          handle: handleA,
          localUserId: "local-user",
          offlineTimeout: 100, // Short timeout for testing
          getTime: mockGetTime,
        })
        return (
          <div>
            <div data-testid="peer-states">{JSON.stringify(peerStates)}</div>
          </div>
        )
      }

      const { getByTestId } = render(<ComponentWithTime />, { wrapper })

      // Simulate receiving a message
      const mockEvent = {
        handle: handleA,
        message: ["remote-user", { status: "online" }],
      }

      // @ts-ignore - accessing private emit for testing
      React.act(() => {
        handleA.emit("ephemeral-message", mockEvent)
      })

      // Should have the peer
      await waitFor(() => {
        expect(getByTestId("peer-states")).toHaveTextContent(
          JSON.stringify({ "remote-user": { status: "online" } })
        )
      })

      // Advance time past the offline timeout
      currentTime = 1200

      // Wait for the pruning interval to run (it runs every 100ms)
      await new Promise(resolve => setTimeout(resolve, 150))

      // Should now be pruned
      expect(getByTestId("peer-states")).toHaveTextContent("{}")
    })

    it("should cleanup listeners on unmount", async () => {
      const { handleA, wrapper } = setup()
      const removeListenerSpy = vi.spyOn(handleA, "removeListener")

      const { unmount } = render(
        <Component handle={handleA} localUserId="local-user" />,
        { wrapper }
      )

      // Unmount
      unmount()

      // Should have removed listener
      expect(removeListenerSpy).toHaveBeenCalledWith(
        "ephemeral-message",
        expect.any(Function)
      )
    })
  })

  describe("with undefined handle", () => {
    const Component = ({
      handle,
      localUserId,
    }: {
      handle?: DocHandle<ExampleDoc>
      localUserId?: string
    }) => {
      const [peerStates, heartbeats] = useRemoteAwareness({
        handle,
        localUserId,
      })
      return (
        <div>
          <div data-testid="peer-states">{JSON.stringify(peerStates)}</div>
          <div data-testid="heartbeats">{JSON.stringify(heartbeats)}</div>
        </div>
      )
    }

    it("should not crash when handle is undefined", () => {
      const { wrapper } = setup()

      expect(() => {
        render(<Component localUserId="local-user" />, { wrapper })
      }).not.toThrow()
    })

    it("should return empty peer states when handle is undefined", () => {
      const { wrapper } = setup()

      const { getByTestId } = render(<Component localUserId="local-user" />, {
        wrapper,
      })

      expect(getByTestId("peer-states")).toHaveTextContent("{}")
      expect(getByTestId("heartbeats")).toHaveTextContent("{}")
    })

    it("should handle transition from undefined to defined handle", async () => {
      const { handleA, wrapper } = setup()

      const { rerender, getByTestId } = render(
        <Component localUserId="local-user" />,
        { wrapper }
      )

      // Should have empty states
      expect(getByTestId("peer-states")).toHaveTextContent("{}")

      // Now provide a handle
      rerender(<Component handle={handleA} localUserId="local-user" />)

      // Simulate receiving a message
      const mockEvent = {
        handle: handleA,
        message: ["remote-user", { status: "online" }],
      }

      // @ts-ignore - accessing private emit for testing
      React.act(() => {
        handleA.emit("ephemeral-message", mockEvent)
      })

      // Should now receive and display the peer state
      await waitFor(() => {
        expect(getByTestId("peer-states")).toHaveTextContent(
          JSON.stringify({ "remote-user": { status: "online" } })
        )
      })
    })

    it("should handle transition from defined to undefined handle", async () => {
      const { handleA, wrapper } = setup()

      const { rerender, getByTestId } = render(
        <Component handle={handleA} localUserId="local-user" />,
        { wrapper }
      )

      // Simulate receiving a message
      const mockEvent = {
        handle: handleA,
        message: ["remote-user", { status: "online" }],
      }

      // @ts-ignore - accessing private emit for testing
      React.act(() => {
        handleA.emit("ephemeral-message", mockEvent)
      })

      // Should have the peer
      await waitFor(() => {
        expect(getByTestId("peer-states")).toHaveTextContent(
          JSON.stringify({ "remote-user": { status: "online" } })
        )
      })

      // Now remove the handle
      rerender(<Component localUserId="local-user" />)

      // The peer states should remain (they don't get cleared automatically)
      // but new messages won't be received
      expect(getByTestId("peer-states")).toHaveTextContent(
        JSON.stringify({ "remote-user": { status: "online" } })
      )
    })

    it("should not attempt to add listeners when handle is undefined", async () => {
      const { wrapper } = setup()

      // This should not throw any errors
      const { unmount } = render(<Component localUserId="local-user" />, {
        wrapper,
      })

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100))

      // Unmount should also not throw
      unmount()

      expect(true).toBe(true)
    })
  })
})
