import {
  AutomergeUrl,
  generateAutomergeUrl,
  PeerId,
  Repo,
} from "@automerge/automerge-repo"
import { render, screen, waitFor } from "@testing-library/react"
import React, { Suspense } from "react"
import { describe, expect, it, vi } from "vitest"
import { useDocument } from "../src/useDocument"
import { RepoContext } from "../src/useRepo"
import { ErrorBoundary } from "react-error-boundary"

interface ExampleDoc {
  foo: string
}

describe("useDocument", () => {
  function setup() {
    const repo = new Repo({
      peerId: "bob" as PeerId,
    })

    const handleA = repo.create<ExampleDoc>()
    handleA.change(doc => (doc.foo = "A"))

    const handleB = repo.create<ExampleDoc>()
    handleB.change(doc => (doc.foo = "B"))

    const handleC = repo.create<ExampleDoc>()
    handleC.change(doc => (doc.foo = "C"))

    const wrapper = ({ children }) => {
      return (
        <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>
      )
    }

    return {
      repo,
      handleA,
      handleB,
      handleC,
      wrapper,
    }
  }

  const Component = ({
    url,
    onDoc,
  }: {
    url: AutomergeUrl
    onDoc: (doc: ExampleDoc) => void
  }) => {
    const [doc] = useDocument<ExampleDoc>(url)
    onDoc(doc)
    return <div data-testid="content">{doc.foo}</div>
  }

  it("should load a document", async () => {
    const { handleA, wrapper } = setup()
    const onDoc = vi.fn()

    render(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleA.url} onDoc={onDoc} />
      </Suspense>,
      { wrapper }
    )

    // Because we created the documents, they should be ready immediately
    expect(screen.getByTestId("content")).toHaveTextContent("A")

    // Now check our spy got called with the document
    expect(onDoc).toHaveBeenCalledWith({ foo: "A" })
  })

  it("should update if the doc changes", async () => {
    const { wrapper, handleA } = setup()
    const onDoc = vi.fn()

    render(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleA.url} onDoc={onDoc} />
      </Suspense>,
      { wrapper }
    )

    // Wait for initial render
    await waitFor(() => {
      expect(screen.getByTestId("content")).toHaveTextContent("A")
    })
    expect(onDoc).toHaveBeenCalledWith({ foo: "A" })

    // Change the document
    React.act(() => handleA.change(doc => (doc.foo = "new value")))

    // Check the update
    await waitFor(() => {
      expect(screen.getByTestId("content")).toHaveTextContent("new value")
    })
    expect(onDoc).toHaveBeenCalledWith({ foo: "new value" })
  })

  it("should throw error if the doc is deleted", async () => {
    const { wrapper, handleA } = setup()
    const onDoc = vi.fn()
    const onError = vi.fn()

    render(
      <ErrorBoundary
        fallback={<div data-testid="error">Error</div>}
        onError={onError}
      >
        <Suspense fallback={<div data-testid="loading">Loading...</div>}>
          <Component url={handleA.url} onDoc={onDoc} />
        </Suspense>
      </ErrorBoundary>,
      { wrapper }
    )

    // Wait for initial render
    await waitFor(() => {
      expect(screen.getByTestId("content")).toHaveTextContent("A")
    })

    // Delete the document
    React.act(() => handleA.delete())

    // Should trigger error boundary
    expect(screen.getByTestId("error")).toHaveTextContent("Error")
  })

  it("should switch documents when url changes", async () => {
    const { handleA, handleB, wrapper } = setup()
    const onDoc = vi.fn()

    const { rerender } = render(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleA.url} onDoc={onDoc} />
      </Suspense>,
      { wrapper }
    )

    // Wait for first document
    await waitFor(() => {
      expect(screen.getByTestId("content")).toHaveTextContent("A")
    })
    expect(onDoc).toHaveBeenCalledWith({ foo: "A" })

    // Switch to second document
    rerender(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleB.url} onDoc={onDoc} />
      </Suspense>
    )

    // Should show loading then new content
    await waitFor(() => {
      expect(screen.getByTestId("content")).toHaveTextContent("B")
    })
    expect(onDoc).toHaveBeenCalledWith({ foo: "B" })
  })

  it("should handle unavailable documents", async () => {
    const { wrapper, repo } = setup()

    // Create handle for nonexistent document
    const url = generateAutomergeUrl()

    render(
      <ErrorBoundary fallback={<div data-testid="error">Error</div>}>
        <Suspense fallback={<div data-testid="loading">Loading...</div>}>
          <Component url={url} onDoc={vi.fn()} />
        </Suspense>
      </ErrorBoundary>,
      { wrapper }
    )

    waitFor(() => {
      expect(screen.getByTestId("error")).toHaveTextContent("Error")
    })
  })

  // Test concurrent document switches
  it("should handle rapid document switches correctly", async () => {
    const { wrapper, handleA, handleB, handleC } = setup()
    const onDoc = vi.fn()

    const { rerender } = render(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleA.url} onDoc={onDoc} />
      </Suspense>,
      { wrapper }
    )

    // Quick switches between documents
    rerender(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleB.url} onDoc={onDoc} />
      </Suspense>
    )
    rerender(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleC.url} onDoc={onDoc} />
      </Suspense>
    )

    // Should eventually settle on final document
    await waitFor(() => {
      expect(screen.getByTestId("content")).toHaveTextContent("C")
    })
    expect(onDoc).toHaveBeenCalledWith({ foo: "C" })
  })

  // Test cleanup on unmount
  it("should cleanup subscriptions on unmount", async () => {
    const { wrapper, handleA } = setup()
    const { unmount } = render(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleA.url} onDoc={vi.fn()} />
      </Suspense>,
      { wrapper }
    )

    // Wait for initial render
    await waitFor(() => {
      expect(screen.getByTestId("content")).toBeInTheDocument()
    })

    // Spy on removeListener
    const removeListenerSpy = vi.spyOn(handleA, "removeListener")

    // Unmount component
    unmount()

    // Should have cleaned up listeners
    expect(removeListenerSpy).toHaveBeenCalledWith(
      "change",
      expect.any(Function)
    )
    expect(removeListenerSpy).toHaveBeenCalledWith(
      "delete",
      expect.any(Function)
    )
  })
})
