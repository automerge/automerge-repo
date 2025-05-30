import React, { Suspense } from "react"
import {
  AutomergeUrl,
  DocHandle,
  generateAutomergeUrl,
  PeerId,
  Repo,
} from "@automerge/automerge-repo"
import { render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom"

import { describe, expect, it, vi } from "vitest"
import { useDocHandle } from "../src/useDocHandle"
import { ErrorBoundary } from "react-error-boundary"
import { setup, setupPairedRepos } from "./testSetup"

describe("useDocHandle", () => {
  const repo = new Repo({
    peerId: "bob" as PeerId,
  })

  const Component = ({
    url,
    onHandle,
  }: {
    url: AutomergeUrl
    onHandle: (handle: DocHandle<unknown>) => void
  }) => {
    const handle = useDocHandle(url, { suspense: true })
    onHandle(handle)
    return null
  }

  it("loads a handle", async () => {
    const { handleA, wrapper } = setup()
    const onHandle = vi.fn()

    render(
      <Suspense fallback={null}>
        <Component url={handleA.url} onHandle={onHandle} />
      </Suspense>,
      { wrapper }
    )
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))
  })

  it("updates the handle when the url changes", async () => {
    const { wrapper, handleA, handleB } = setup()
    const onHandle = vi.fn()

    const { rerender } = render(
      <Component url={handleA.url} onHandle={onHandle} />,
      { wrapper }
    )
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))

    // set url to doc B
    rerender(<Component url={handleB.url} onHandle={onHandle} />)
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleB))
  })

  it("does not return undefined after the url is updated", async () => {
    const { wrapper, handleA, handleB } = setup()
    const onHandle = vi.fn()

    const { rerender } = render(
      <Component url={handleA.url} onHandle={onHandle} />,
      { wrapper }
    )
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))

    const onHandle2 = vi.fn()

    // set url to doc B
    rerender(<Component url={handleB.url} onHandle={onHandle2} />)
    await waitFor(() => expect(onHandle2).not.toHaveBeenCalledWith(undefined))
  })

  it("handles unavailable documents correctly", async () => {
    // suppress console.error from the error boundary
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const { repo, wrapper } = await setup()
    const url = generateAutomergeUrl()

    render(
      <ErrorBoundary fallback={<div data-testid="error">Error</div>}>
        <Suspense fallback={<div data-testid="loading">Loading...</div>}>
          <Component
            url={url}
            onHandle={() => {
              throw new Error("Should not reach here")
            }}
          />
        </Suspense>
      </ErrorBoundary>,
      { wrapper }
    )

    // Then wait for the error boundary to render its fallback
    await waitFor(() => {
      expect(screen.getByTestId("error")).toBeInTheDocument()
      // Optional: verify loading is no longer shown
      expect(screen.queryByTestId("loading")).not.toBeInTheDocument()
    })

    consoleSpy.mockRestore()
  })

  it("handles slow network correctly", async () => {
    const { repoCreator, wrapper } = setupPairedRepos()
    const handleA = repoCreator.create({ foo: "A" })
    const onHandle = vi.fn()

    render(
      <ErrorBoundary fallback={<div data-testid="error">Error</div>}>
        <Suspense fallback={<div data-testid="loading">Loading...</div>}>
          <Component url={handleA.url} onHandle={onHandle} />
        </Suspense>
      </ErrorBoundary>,
      { wrapper }
    )

    // Verify loading state is shown initially
    expect(screen.getByTestId("loading")).toBeInTheDocument()
    expect(onHandle).not.toHaveBeenCalled()

    // Wait for successful resolution
    await waitFor(() => {
      // Loading state should be gone
      expect(screen.queryByTestId("loading")).not.toBeInTheDocument()
    })

    // Verify callback was called with correct handle
    expect(onHandle).toHaveBeenCalledWith(
      expect.objectContaining({ url: handleA.url })
    )

    // Verify error boundary never rendered
    expect(screen.queryByTestId("error")).not.toBeInTheDocument()
  })

  it("suspends while loading a handle", async () => {
    const { repoCreator, wrapper } = await setupPairedRepos()
    const handleA = repoCreator.create({ foo: "A" })
    const onHandle = vi.fn()

    render(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleA.url} onHandle={onHandle} />
      </Suspense>,
      { wrapper }
    )

    // Should show loading state
    expect(screen.getByTestId("loading")).toBeInTheDocument()
    expect(onHandle).not.toHaveBeenCalled()

    // Should show content
    await waitFor(() => {
      expect(onHandle).toHaveBeenCalledWith(
        expect.objectContaining({ url: handleA.url })
      )
    })
  })

  it("handles rapid url changes during loading", async () => {
    const { repoCreator, repoFinder, wrapper } = await setupPairedRepos()
    const handleA = repoCreator.create({ foo: "A" })
    const handleB = repoFinder.create({ foo: "B" })
    const onHandle = vi.fn()

    const { rerender } = render(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleA.url} onHandle={onHandle} />
      </Suspense>,
      { wrapper }
    )

    // Quickly switch to B before A loads
    rerender(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleB.url} onHandle={onHandle} />
      </Suspense>
    )

    // Should eventually resolve with B, not A
    await waitFor(() => {
      expect(onHandle).toHaveBeenLastCalledWith(handleB)
      expect(onHandle).not.toHaveBeenCalledWith(
        expect.objectContaining({ url: handleA.url })
      )
    })
  })

  describe("useDocHandle with suspense: false", () => {
    it("returns undefined while loading then resolves to handle", async () => {
      const { repoCreator, wrapper } = await setupPairedRepos()
      const handleA = repoCreator.create({ foo: "A" })

      const onHandle = vi.fn()

      const NonSuspenseComponent = ({
        url,
        onHandle,
      }: {
        url: AutomergeUrl
        onHandle: (handle: DocHandle<unknown> | undefined) => void
      }) => {
        const handle = useDocHandle(url, { suspense: false })
        onHandle(handle)
        return null
      }

      render(<NonSuspenseComponent url={handleA.url} onHandle={onHandle} />, {
        wrapper,
      })

      // Initially should be called with undefined
      expect(onHandle).toHaveBeenCalledWith(undefined)

      // Wait for handle to load
      await waitFor(() => {
        expect(onHandle).toHaveBeenCalledWith(
          expect.objectContaining({ url: handleA.url })
        )
      })
    })

    it("handles unavailable documents by returning undefined", async () => {
      const { repo, wrapper } = await setup()
      const url = generateAutomergeUrl()
      const onHandle = vi.fn()

      const NonSuspenseComponent = ({
        url,
        onHandle,
      }: {
        url: AutomergeUrl
        onHandle: (handle: DocHandle<unknown> | undefined) => void
      }) => {
        const handle = useDocHandle(url, { suspense: false })
        onHandle(handle)
        return null
      }

      render(<NonSuspenseComponent url={url} onHandle={onHandle} />, {
        wrapper,
      })

      // Should start with undefined
      expect(onHandle).toHaveBeenCalledWith(undefined)

      // Should continue to return undefined after attempted load
      await waitFor(() => {
        expect(onHandle).toHaveBeenLastCalledWith(undefined)
      })
    })

    it("updates the handle when url changes", async () => {
      const { wrapper, handleA, handleB } = setup()
      const onHandle = vi.fn()

      const NonSuspenseComponent = ({
        url,
        onHandle,
      }: {
        url: AutomergeUrl
        onHandle: (handle: DocHandle<unknown> | undefined) => void
      }) => {
        const handle = useDocHandle(url, { suspense: false })
        onHandle(handle)
        return null
      }

      const { rerender } = render(
        <NonSuspenseComponent url={handleA.url} onHandle={onHandle} />,
        { wrapper }
      )

      // Wait for first handle to load
      await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))

      // Change URL
      rerender(<NonSuspenseComponent url={handleB.url} onHandle={onHandle} />)

      // Then resolve to new handle
      await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleB))
    })
  })
})
