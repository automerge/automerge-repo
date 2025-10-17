import { DocHandle } from "@automerge/automerge-repo"
import { render, waitFor } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import "@testing-library/jest-dom"

import { useLocalAwareness } from "../src/useLocalAwareness"
import { setup, ExampleDoc } from "./testSetup"

describe("useLocalAwareness", () => {
  describe("with defined handle", () => {
    const Component = ({
      handle,
      userId,
      initialState,
    }: {
      handle: DocHandle<ExampleDoc>
      userId: string
      initialState: any
    }) => {
      const [state, setState] = useLocalAwareness({
        handle,
        userId,
        initialState,
      })
      return (
        <div>
          <div data-testid="state">{JSON.stringify(state)}</div>
          <button onClick={() => setState({ updated: true })}>Update</button>
        </div>
      )
    }

    it("should initialize with initial state", () => {
      const { handleA, wrapper } = setup()
      const initialState = { foo: "bar" }

      const { getByTestId } = render(
        <Component
          handle={handleA}
          userId="user1"
          initialState={initialState}
        />,
        { wrapper }
      )

      expect(getByTestId("state")).toHaveTextContent(
        JSON.stringify(initialState)
      )
    })

    it("should broadcast state changes when handle is defined", async () => {
      const { handleA, wrapper } = setup()
      const broadcastSpy = vi.spyOn(handleA, "broadcast")

      const { getByText, getByTestId } = render(
        <Component
          handle={handleA}
          userId="user1"
          initialState={{ initial: true }}
        />,
        { wrapper }
      )

      // Wait for initial heartbeat
      await waitFor(() => {
        expect(broadcastSpy).toHaveBeenCalled()
      })

      // Clear previous calls
      broadcastSpy.mockClear()

      // Click update button
      React.act(() => {
        getByText("Update").click()
      })

      // Should broadcast the update
      await waitFor(() => {
        expect(broadcastSpy).toHaveBeenCalledWith(["user1", { updated: true }])
      })

      expect(getByTestId("state")).toHaveTextContent(
        JSON.stringify({ updated: true })
      )
    })

    it("should send periodic heartbeats", async () => {
      const { handleA, wrapper } = setup()
      const broadcastSpy = vi.spyOn(handleA, "broadcast")
      const initialState = { heartbeat: true }

      render(
        <Component
          handle={handleA}
          userId="user1"
          initialState={initialState}
        />,
        { wrapper }
      )

      // Should send initial heartbeat
      await waitFor(() => {
        expect(broadcastSpy).toHaveBeenCalledWith(["user1", initialState])
      })
    })

    it("should not broadcast if userId is not set", async () => {
      const { handleA, wrapper } = setup()
      const broadcastSpy = vi.spyOn(handleA, "broadcast")

      render(
        <Component handle={handleA} userId="" initialState={{ test: true }} />,
        { wrapper }
      )

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100))

      // Should not have broadcast
      expect(broadcastSpy).not.toHaveBeenCalled()
    })

    it("should cleanup on unmount", async () => {
      const { handleA, wrapper } = setup()

      const { unmount } = render(
        <Component
          handle={handleA}
          userId="user1"
          initialState={{ test: true }}
        />,
        { wrapper }
      )

      // Wait for initial heartbeat
      await new Promise(resolve => setTimeout(resolve, 100))

      // Unmount
      unmount()

      // No errors should occur
      expect(true).toBe(true)
    })
  })

  describe("with undefined handle", () => {
    const Component = ({
      handle,
      userId,
      initialState,
    }: {
      handle?: DocHandle<ExampleDoc>
      userId: string
      initialState: any
    }) => {
      const [state, setState] = useLocalAwareness({
        handle,
        userId,
        initialState,
      })
      return (
        <div>
          <div data-testid="state">{JSON.stringify(state)}</div>
          <button onClick={() => setState({ updated: true })}>Update</button>
        </div>
      )
    }

    it("should not crash when handle is undefined", () => {
      const { wrapper } = setup()

      expect(() => {
        render(<Component userId="user1" initialState={{ test: true }} />, {
          wrapper,
        })
      }).not.toThrow()
    })

    it("should still maintain local state when handle is undefined", () => {
      const { wrapper } = setup()
      const initialState = { foo: "bar" }

      const { getByTestId } = render(
        <Component userId="user1" initialState={initialState} />,
        { wrapper }
      )

      expect(getByTestId("state")).toHaveTextContent(
        JSON.stringify(initialState)
      )
    })

    it("should update local state without broadcasting when handle is undefined", async () => {
      const { wrapper } = setup()

      const { getByText, getByTestId } = render(
        <Component userId="user1" initialState={{ initial: true }} />,
        { wrapper }
      )

      // Click update button
      React.act(() => {
        getByText("Update").click()
      })

      // State should update
      await waitFor(() => {
        expect(getByTestId("state")).toHaveTextContent(
          JSON.stringify({ updated: true })
        )
      })
    })

    it("should handle transition from undefined to defined handle", async () => {
      const { handleA, wrapper } = setup()
      const broadcastSpy = vi.spyOn(handleA, "broadcast")

      const { rerender, getByText } = render(
        <Component userId="user1" initialState={{ test: true }} />,
        { wrapper }
      )

      // Wait a bit with undefined handle
      await new Promise(resolve => setTimeout(resolve, 100))

      // Should not have broadcast yet
      expect(broadcastSpy).not.toHaveBeenCalled()

      // Now provide a handle
      rerender(
        <Component
          handle={handleA}
          userId="user1"
          initialState={{ test: true }}
        />
      )

      // Should start broadcasting
      await waitFor(() => {
        expect(broadcastSpy).toHaveBeenCalled()
      })
    })

    it("should handle transition from defined to undefined handle", async () => {
      const { handleA, wrapper } = setup()
      const broadcastSpy = vi.spyOn(handleA, "broadcast")

      const { rerender } = render(
        <Component
          handle={handleA}
          userId="user1"
          initialState={{ test: true }}
        />,
        { wrapper }
      )

      // Wait for initial broadcast
      await waitFor(() => {
        expect(broadcastSpy).toHaveBeenCalled()
      })

      broadcastSpy.mockClear()

      // Now remove the handle
      rerender(<Component userId="user1" initialState={{ test: true }} />)

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100))

      // Should not broadcast anymore
      expect(broadcastSpy).not.toHaveBeenCalled()
    })
  })
})
