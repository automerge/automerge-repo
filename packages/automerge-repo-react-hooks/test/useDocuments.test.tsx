import React, { Suspense } from "react"
import { AutomergeUrl, Repo, PeerId } from "@automerge/automerge-repo"
import { render, act, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useDocuments } from "../src/useDocuments"
import { ErrorBoundary } from "react-error-boundary"
import { ExampleDoc, setup, setupPairedRepos } from "./testSetup"

describe("useDocuments", () => {
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
    const [docs] = onState.mock.lastCall || []
    expect(docs.get(handleA.url)?.foo).toBe("A")

    // Make a change
    const [, change] = onState.mock.lastCall || []
    await act(async () => {
      change(handleA.url, doc => (doc.foo = "Changed"))
      await Promise.resolve()
    })

    // Verify change was synced
    const [finalDocs] = onState.mock.lastCall || []
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
    const [docs, change] = onState.mock.lastCall || []
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
    const [finalDocs] = onState.mock.lastCall || []
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
    let [docs] = onState.mock.lastCall || []
    expect(docs.size).toBe(2)

    // Remove one document
    rerender(<Wrapped urls={[handleA.url]} />)

    await act(async () => {
      await Promise.resolve()
    })

    // Check document was removed
    docs = onState.mock.lastCall?.[0]
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

    const [, change] = onState.mock.lastCall || []

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
    const [finalDocs] = onState.mock.lastCall || []
    expect(finalDocs.get(handleA.url)?.counter).toBe(4)
  })

  describe("useDocuments with suspense: false", () => {
    const NonSuspendingDocumentsComponent = ({
      urls,
      onState,
    }: {
      urls: AutomergeUrl[]
      onState: (docs: Map<AutomergeUrl, ExampleDoc>, change: any) => void
    }) => {
      const [docs, change] = useDocuments<ExampleDoc>(urls, { suspense: false })
      onState(docs, change)
      return null
    }

    it("should start with already-loaded documents and load other documents asynchronously", async () => {
      const { repoCreator, repoFinder, wrapper } = setupPairedRepos()
      const handleA = repoFinder.create({ foo: "A" })
      const handleB = repoCreator.create({ foo: "B" })

      const onState = vi.fn()

      const Wrapped = () => (
        <ErrorBoundary fallback={<div>Error!</div>}>
          <NonSuspendingDocumentsComponent
            urls={[handleA.url, handleB.url]}
            onState={onState}
          />
        </ErrorBoundary>
      )

      render(<Wrapped />, { wrapper })

      // Initial state should include local document
      expect(onState).toHaveBeenCalled()
      let docs = onState.mock.lastCall?.[0]
      expect(docs.size).toBe(1)
      expect(docs.get(handleA.url)?.foo).toBe("A")

      // Wait for remote document to load
      await act(async () => {
        await repoFinder.find(handleB.url)
      })

      // Both should now be loaded
      docs = onState.mock.lastCall?.[0]
      expect(docs.size).toBe(2)
      expect(docs.get(handleA.url)?.foo).toBe("A")
      expect(docs.get(handleB.url)?.foo).toBe("B")
    })

    it("should handle loading multiple documents asynchronously", async () => {
      const { repoCreator, repoFinder, wrapper } = setupPairedRepos()
      const handleA = repoCreator.create({ foo: "A" })
      const handleB = repoCreator.create({ foo: "B" })
      const onState = vi.fn()

      const Wrapped = () => (
        <ErrorBoundary fallback={<div>Error!</div>}>
          <NonSuspendingDocumentsComponent
            urls={[handleA.url, handleB.url]}
            onState={onState}
          />
        </ErrorBoundary>
      )

      render(<Wrapped />, { wrapper })

      // Initial state should be empty
      let docs = onState.mock.lastCall?.[0]
      expect(docs.size).toBe(0)

      // Wait for documents to load
      await act(async () => {
        await Promise.all([
          repoFinder.find(handleA.url),
          repoFinder.find(handleB.url),
        ])
      })

      // Check loaded state
      docs = onState.mock.lastCall?.[0]
      expect(docs.size).toBe(2)
      expect(docs.get(handleA.url)?.foo).toBe("A")
      expect(docs.get(handleB.url)?.foo).toBe("B")

      // Make changes after loading
      const [, change] = onState.mock.lastCall || []
      await act(async () => {
        change(handleA.url, doc => {
          doc.counter = 1
          doc.nested = { value: "A1" }
        })
        change(handleB.url, doc => {
          doc.counter = 2
          doc.nested = { value: "B1" }
        })
      })

      // Verify changes
      const [finalDocs] = onState.mock.lastCall || []
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

    it("should handle document removal with pending loads", async () => {
      const { repoCreator, repoFinder, wrapper } = setupPairedRepos()
      const handleA = repoCreator.create({ foo: "A" })
      const handleB = repoCreator.create({ foo: "B" })

      const onState = vi.fn()

      const Wrapped = ({ urls }: { urls: AutomergeUrl[] }) => (
        <ErrorBoundary fallback={<div>Error!</div>}>
          <NonSuspendingDocumentsComponent urls={urls} onState={onState} />
        </ErrorBoundary>
      )

      const { rerender } = render(
        <Wrapped urls={[handleA.url, handleB.url]} />,
        { wrapper }
      )

      // Initial state should be empty
      let docs = onState.mock.lastCall?.[0]
      expect(docs).toBeDefined()
      expect(docs.size).toBe(0)

      // Remove one document before load completes
      rerender(<Wrapped urls={[handleA.url]} />)

      // Wait for remaining document to load
      await act(async () => {
        await Promise.all([
          repoFinder.find(handleA.url),
          repoFinder.find(handleB.url),
        ])
      })

      // Should only have loaded the remaining document
      waitFor(() => {
        docs = onState.mock.lastCall?.[0]
        expect(docs.size).toBe(1)
        expect(docs.has(handleA.url)).toBe(true)
        expect(docs.has(handleB.url)).toBe(false)
      })
    })

    it("should clean up listeners when unmounting with pending loads", async () => {
      const { repoCreator, repoFinder, wrapper } = setupPairedRepos()
      const onState = vi.fn()

      const handleA = repoCreator.create({ foo: "bar" })
      const Wrapped = () => (
        <ErrorBoundary fallback={<div>Error!</div>}>
          <NonSuspendingDocumentsComponent
            urls={[handleA.url]}
            onState={onState}
          />
        </ErrorBoundary>
      )

      const { unmount } = render(<Wrapped />, { wrapper })

      // Initial state empty
      expect(onState.mock.lastCall?.[0].size).toBe(0)

      // Unmount before load completes
      unmount()

      // Wait for what would have been load completion
      let finderHandleA
      await act(async () => {
        finderHandleA = await repoFinder.find(handleA.url)
      })

      // Should not have received any updates after unmount
      const callCount = onState.mock.calls.length
      finderHandleA.change(doc => (doc.foo = "Changed after unmount"))
      expect(onState.mock.calls.length).toBe(callCount)
    })

    it("should handle document changes during loading", async () => {
      const { handleA, wrapper } = setup()
      const onState = vi.fn()

      const Wrapped = () => (
        <ErrorBoundary fallback={<div>Error!</div>}>
          <NonSuspendingDocumentsComponent
            urls={[handleA.url]}
            onState={onState}
          />
        </ErrorBoundary>
      )

      render(<Wrapped />, { wrapper })

      // Make a change while document is loading
      handleA.change(doc => (doc.counter = 1))

      // Wait for load
      await act(async () => {
        await Promise.resolve()
      })

      // Should have latest state
      const [docs] = onState.mock.lastCall || []
      expect(docs.get(handleA.url)).toEqual({
        foo: "A",
        counter: 1,
      })
    })

    it("should handle invalid urls with empty map", async () => {
      const { wrapper } = setup()
      const onState = vi.fn()
      const invalidUrl = "invalid-url" as AutomergeUrl

      const Wrapped = () => (
        <ErrorBoundary fallback={<div>Error!</div>}>
          <NonSuspendingDocumentsComponent
            urls={[invalidUrl]}
            onState={onState}
          />
        </ErrorBoundary>
      )

      render(<Wrapped />, { wrapper })

      // Initial state empty
      let docs = onState.mock.lastCall?.[0]
      expect(docs).toBeDefined()
      expect(docs.size).toBe(0)

      // Should remain empty after attempted load
      await act(async () => {
        await Promise.resolve()
      })

      docs = onState.mock.lastCall?.[0]
      expect(docs).toBeDefined()
      expect(docs.size).toBe(0)
    })
  })
})
