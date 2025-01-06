import React, { Suspense } from "react"
import {
  AutomergeUrl,
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

describe("useHandle", () => {
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
    const handle = useDocHandle(url)
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

  it("does not return a handle for a different url after the url is updated", async () => {
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
    await waitFor(() => expect(onHandle2).not.toHaveBeenCalledWith(handleA))
  })

  it("suspends while loading a handle", async () => {
    const { handleA, wrapper } = await setup()
    const onHandle = vi.fn()
    let promiseResolve: (value: DocHandle<ExampleDoc>) => void

    // Mock find to return a delayed promise
    const originalFind = repo.find.bind(repo)
    repo.find = vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          promiseResolve = resolve
        })
    )

    render(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleA.url} onHandle={onHandle} />
      </Suspense>,
      { wrapper }
    )

    // Should show loading state
    expect(screen.getByTestId("loading")).toBeInTheDocument()
    expect(onHandle).not.toHaveBeenCalled()

    // Resolve the find
    promiseResolve!(await originalFind(handleA.url))

    // Should show content
    await waitFor(() => {
      expect(onHandle).toHaveBeenCalledWith(handleA)
    })
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

  it("handles slow network correctly", async () => {
    const { handleA, repo, wrapper } = await setup()
    const onHandle = vi.fn()

    // Mock find to simulate slow network
    const originalFind = repo.find.bind(repo)
    repo.find = vi.fn().mockImplementation(async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return originalFind(...args)
    })

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
    expect(onHandle).toHaveBeenCalledWith(handleA)

    // Verify error boundary never rendered
    expect(screen.queryByTestId("error")).not.toBeInTheDocument()
  })

  it("handles rapid url changes during loading", async () => {
    const { handleA, handleB, wrapper } = await setup()
    const onHandle = vi.fn()
    const delays: Record<string, number> = {
      [handleA.url]: 100,
      [handleB.url]: 50,
    }

    // Mock find to simulate different network delays
    const originalFind = repo.find.bind(repo)
    repo.find = vi.fn().mockImplementation(async (url: string) => {
      await new Promise(resolve => setTimeout(resolve, delays[url]))
      return originalFind(url)
    })

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
      expect(onHandle).not.toHaveBeenCalledWith(handleA)
    })
  })
})
