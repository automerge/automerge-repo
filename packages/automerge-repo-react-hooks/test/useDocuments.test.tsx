import React, { Suspense } from "react"
import { AutomergeUrl, Repo, PeerId } from "@automerge/automerge-repo"
import { render, act } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useDocuments } from "../src/useDocuments"
import { RepoContext } from "../src/useRepo"
import { ErrorBoundary } from "react-error-boundary"

interface ExampleDoc {
  foo: string
  counter?: number
  nested?: {
    value: string
  }
}

function getRepoWrapper(repo: Repo) {
  return ({ children }) => (
    <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>
  )
}

describe("useDocuments", () => {
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

  const DocumentsComponent = ({
    urls,
    onState,
  }: {
    urls: AutomergeUrl[]
    onState: (docs: Map<AutomergeUrl, ExampleDoc>, change: any) => void
  }) => {
    const [docs, change] = useDocuments<ExampleDoc>(urls)
    onState(docs, change)
    return null
  }

  it("should sync documents and handle changes", async () => {
    const { handleA, wrapper } = setup()
    const onState = vi.fn()

    const Wrapped = () => (
      <ErrorBoundary fallback={<div>Error!</div>}>
        <Suspense fallback={<div>Loading...</div>}>
          <DocumentsComponent urls={[handleA.url]} onState={onState} />
        </Suspense>
      </ErrorBoundary>
    )

    await act(async () => {
      render(<Wrapped />, { wrapper })
    })

    await act(async () => {
      await Promise.resolve()
    })

    // Initial state
    expect(onState).toHaveBeenCalled()
    const [docs] = onState.mock.lastCall
    expect(docs.get(handleA.url)?.foo).toBe("A")

    // Make a change
    const [, change] = onState.mock.lastCall
    await act(async () => {
      change(handleA.url, doc => (doc.foo = "Changed"))
      await Promise.resolve()
    })

    // Verify change was synced
    const [finalDocs] = onState.mock.lastCall
    expect(finalDocs.get(handleA.url)?.foo).toBe("Changed")
  })

  it("should handle multiple documents and parallel changes", async () => {
    const { handleA, handleB, wrapper } = setup()
    const onState = vi.fn()

    const Wrapped = () => (
      <ErrorBoundary fallback={<div>Error!</div>}>
        <Suspense fallback={<div>Loading...</div>}>
          <DocumentsComponent
            urls={[handleA.url, handleB.url]}
            onState={onState}
          />
        </Suspense>
      </ErrorBoundary>
    )

    await act(async () => {
      render(<Wrapped />, { wrapper })
    })

    await act(async () => {
      await Promise.resolve()
    })

    // Check initial state
    const [docs, change] = onState.mock.lastCall
    expect(docs.get(handleA.url)?.foo).toBe("A")
    expect(docs.get(handleB.url)?.foo).toBe("B")

    // Make parallel changes
    await act(async () => {
      change(handleA.url, doc => {
        doc.counter = 1
        doc.nested = { value: "A1" }
      })
      change(handleB.url, doc => {
        doc.counter = 2
        doc.nested = { value: "B1" }
      })
      await Promise.resolve()
    })

    // Verify both changes were synced
    const [finalDocs] = onState.mock.lastCall
    expect(finalDocs.get(handleA.url)).toEqual({
      foo: "A",
      counter: 1,
      nested: { value: "A1" },
    })
    expect(finalDocs.get(handleB.url)).toEqual({
      foo: "B",
      counter: 2,
      nested: { value: "B1" },
    })
  })

  it("should handle document removal and cleanup listeners", async () => {
    const { handleA, handleB, wrapper } = setup()
    const onState = vi.fn()

    const Wrapped = ({ urls }: { urls: AutomergeUrl[] }) => (
      <ErrorBoundary fallback={<div>Error!</div>}>
        <Suspense fallback={<div>Loading...</div>}>
          <DocumentsComponent urls={urls} onState={onState} />
        </Suspense>
      </ErrorBoundary>
    )

    const { rerender, unmount } = render(
      <Wrapped urls={[handleA.url, handleB.url]} />,
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
    })

    // Initial state
    let [docs] = onState.mock.lastCall
    expect(docs.size).toBe(2)

    // Remove one document
    rerender(<Wrapped urls={[handleA.url]} />)

    await act(async () => {
      await Promise.resolve()
    })

    // Check document was removed
    docs = onState.mock.lastCall[0]
    expect(docs.size).toBe(1)
    expect(docs.has(handleA.url)).toBe(true)
    expect(docs.has(handleB.url)).toBe(false)

    // Test cleanup
    unmount()

    // Make a change - should not trigger update
    const callCount = onState.mock.calls.length
    handleA.change(doc => (doc.foo = "Changed after unmount"))
    expect(onState.mock.calls.length).toBe(callCount)
  })

  it("should handle rapid successive changes", async () => {
    const { handleA, wrapper } = setup()
    const onState = vi.fn()

    const Wrapped = () => (
      <ErrorBoundary fallback={<div>Error!</div>}>
        <Suspense fallback={<div>Loading...</div>}>
          <DocumentsComponent urls={[handleA.url]} onState={onState} />
        </Suspense>
      </ErrorBoundary>
    )

    await act(async () => {
      render(<Wrapped />, { wrapper })
    })

    await act(async () => {
      await Promise.resolve()
    })

    const [, change] = onState.mock.lastCall

    // Make rapid changes
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        change(handleA.url, doc => {
          doc.counter = i
        })
      }
      await Promise.resolve()
    })

    // Should have final value
    const [finalDocs] = onState.mock.lastCall
    expect(finalDocs.get(handleA.url)?.counter).toBe(4)
  })
})
