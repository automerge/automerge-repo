import React, { Suspense } from "react"
import {
  AutomergeUrl,
  DocHandle,
  Repo,
  PeerId,
} from "@automerge/automerge-repo"
import { render, waitFor, act } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useDocHandles } from "../src/useDocHandles"
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

describe("useDocHandles", () => {
  const repo = new Repo({
    peerId: "bob" as PeerId,
  })

  function setup() {
    const handleA = repo.create<ExampleDoc>()
    handleA.change(doc => (doc.foo = "A"))

    const handleB = repo.create<ExampleDoc>()
    handleB.change(doc => (doc.foo = "B"))

    const handleC = repo.create<ExampleDoc>()
    handleC.change(doc => (doc.foo = "C"))

    return {
      repo,
      handleA,
      handleB,
      handleC,
      handles: [handleA, handleB, handleC],
      urls: [handleA.url, handleB.url, handleC.url],
      wrapper: getRepoWrapper(repo),
    }
  }

  const HandlesComponent = ({
    urls,
    onHandles,
    suspense = true,
  }: {
    urls: AutomergeUrl[]
    onHandles: (
      handles: Map<AutomergeUrl, DocHandle<unknown> | undefined>
    ) => void
    suspense?: boolean
  }) => {
    const handles = useDocHandles(urls, { suspense })
    onHandles(handles)
    return null
  }

  it("should load handles for given urls", async () => {
    const { handleA, handleB, handleC, urls, wrapper } = setup()
    const onHandles = vi.fn()

    const Wrapped = () => (
      <ErrorBoundary fallback={<div>Error!</div>}>
        <Suspense fallback={<div>Loading...</div>}>
          <HandlesComponent urls={urls} onHandles={onHandles} />
        </Suspense>
      </ErrorBoundary>
    )

    await act(async () => {
      render(<Wrapped />, { wrapper })
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(onHandles).toHaveBeenCalled()
    const lastCall = onHandles.mock.lastCall[0]
    expect(lastCall.size).toBe(3)
    expect(lastCall.get(handleA.url)).toBeDefined()
    expect(lastCall.get(handleB.url)).toBeDefined()
    expect(lastCall.get(handleC.url)).toBeDefined()
  })

  it("should handle document removal", async () => {
    const { handleA, handleB, wrapper } = setup()
    const onHandles = vi.fn()

    const Wrapped = ({ urls }: { urls: AutomergeUrl[] }) => (
      <ErrorBoundary fallback={<div>Error!</div>}>
        <Suspense fallback={<div>Loading...</div>}>
          <HandlesComponent urls={urls} onHandles={onHandles} />
        </Suspense>
      </ErrorBoundary>
    )

    const { rerender } = render(<Wrapped urls={[handleA.url, handleB.url]} />, {
      wrapper,
    })

    await act(async () => {
      await Promise.resolve()
    })

    // Initial state
    expect(onHandles.mock.lastCall[0].size).toBe(2)

    // Remove one document
    rerender(<Wrapped urls={[handleA.url]} />)

    await act(async () => {
      await Promise.resolve()
    })

    const lastCall = onHandles.mock.lastCall[0]
    expect(lastCall.size).toBe(1)
    expect(lastCall.has(handleA.url)).toBe(true)
    expect(lastCall.has(handleB.url)).toBe(false)
  })

  it("should handle non-suspense mode", async () => {
    const { handleA, wrapper } = setup()
    const onHandles = vi.fn()

    render(
      <HandlesComponent
        urls={[handleA.url]}
        onHandles={onHandles}
        suspense={false}
      />,
      { wrapper }
    )

    // Initially empty
    expect(onHandles.mock.lastCall[0].size).toBe(0)

    // Wait for handles to load
    await waitFor(() => {
      expect(onHandles.mock.lastCall[0].size).toBe(1)
      expect(onHandles.mock.lastCall[0].get(handleA.url)).toBeDefined()
    })
  })
})
