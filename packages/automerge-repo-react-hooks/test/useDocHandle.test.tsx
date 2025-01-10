import React, { Suspense } from "react"
import {
  AutomergeUrl,
  createSignal,
  DocHandle,
  generateAutomergeUrl,
  PeerId,
  Repo,
} from "@automerge/automerge-repo"
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useDocHandle } from "../src/useDocHandle"
import { RepoContext } from "../src/useRepo"
import { ErrorBoundary } from "react-error-boundary"

interface ExampleDoc {
  foo: string
}

function getRepoWrapper(repo: Repo) {
  return ({ children }) => (
    <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>
  )
}

describe("useDocHandle", () => {
  const repo = new Repo({
    peerId: "bob" as PeerId,
  })

  function setup() {
    const handleA = repo.create<ExampleDoc>()
    handleA.change(doc => (doc.foo = "A"))

    const handleB = repo.create<ExampleDoc>()
    handleB.change(doc => (doc.foo = "B"))

    return {
      repo,
      handleA,
      handleB,
      wrapper: getRepoWrapper(repo),
    }
  }

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
  })

  describe("useDocHandle with suspense: false", () => {
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

      // Both handles are loaded, so we should go straight to the next state
      expect(onHandle).not.toHaveBeenCalledWith(undefined)

      // Then resolve to new handle
      await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleB))
    })
  })

  it("shows loading state for slow documents", async () => {
    const { handleA, wrapper } = await setup()
    const onHandle = vi.fn()

    // Create a signal we can control
    const signal = createSignal({ state: "loading", progress: 0 })

    // Mock findWithSignalProgress to return our controlled signal
    repo.findWithSignalProgress = vi.fn().mockReturnValue(signal)

    render(
      <ErrorBoundary fallback={<div data-testid="error">Error</div>}>
        <Suspense fallback={<div data-testid="loading">Loading...</div>}>
          <Component url={handleA.url} onHandle={onHandle} />
        </Suspense>
      </ErrorBoundary>,
      { wrapper }
    )

    // Should show loading state initially
    expect(screen.getByTestId("loading")).toBeInTheDocument()

    // Make document ready
    signal.set({ state: "ready", handle: handleA })

    // Should eventually show content
    await waitFor(() => {
      expect(onHandle).toHaveBeenCalledWith(handleA)
      expect(screen.queryByTestId("loading")).not.toBeInTheDocument()
    })
  })
})
