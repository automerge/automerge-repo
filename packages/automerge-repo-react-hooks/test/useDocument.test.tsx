import {
  AutomergeUrl,
  Doc,
  generateAutomergeUrl,
  PeerId,
  Repo,
  NetworkAdapter,
  Message,
} from "@automerge/automerge-repo"
import { render, screen, waitFor } from "@testing-library/react"
import React, { Suspense } from "react"
import { describe, expect, it, vi } from "vitest"
import "@testing-library/jest-dom"

import { useDocument } from "../src/useDocument"
import { RepoContext } from "../src/useRepo"
import { ErrorBoundary } from "react-error-boundary"
import { DummyNetworkAdapter, pause } from "../src/helpers/DummyNetworkAdapter"
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

  function setupPairedRepos(latency = 10) {
    // Create two connected repos with network delay
    const [adapterCreator, adapterFinder] =
      DummyNetworkAdapter.createConnectedPair({
        latency,
      })

    const repoCreator = new Repo({
      peerId: "peer-creator" as PeerId,
      network: [adapterCreator],
    })
    const repoFinder = new Repo({
      peerId: "peer-finder" as PeerId,
      network: [adapterFinder],
    })

    // TODO: dummynetwork adapter should probably take care of this
    // Initialize the network.
    adapterCreator.peerCandidate(`peer-finder` as PeerId)
    adapterFinder.peerCandidate(`peer-creator` as PeerId)

    const wrapper = ({ children }) => {
      return (
        <RepoContext.Provider value={repoFinder}>
          {children}
        </RepoContext.Provider>
      )
    }

    return { repoCreator, repoFinder, wrapper }
  }
  const Component = ({
    url,
    onDoc,
  }: {
    url: AutomergeUrl
    onDoc: (doc: Doc<ExampleDoc>) => void
  }) => {
    const [doc] = useDocument<ExampleDoc>(url, { suspense: true })
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

    // Because this document is already loaded locally (we made it)
    // we should see results immediately.
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
    expect(screen.getByTestId("content")).toHaveTextContent("A")
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
    // suppress console.error from the error boundary
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

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

    consoleSpy.mockRestore()
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
    expect(screen.getByTestId("content")).toHaveTextContent("A")
    expect(onDoc).toHaveBeenCalledWith({ foo: "A" })

    // Switch to second document
    rerender(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handleB.url} onDoc={onDoc} />
      </Suspense>
    )

    // Should show loading then new content
    expect(screen.getByTestId("content")).toHaveTextContent("B")
    expect(onDoc).toHaveBeenCalledWith({ foo: "B" })
  })

  it("should handle unavailable documents", async () => {
    // suppress console.error from the error boundary
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

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

    consoleSpy.mockRestore()
  })

  // Test slow-loading document
  it("should handle slow-loading documents", async () => {
    const { repoCreator, wrapper } = setupPairedRepos()

    // Create document in first repo
    const handle = repoCreator.create({ foo: "slow" })
    const onDoc = vi.fn()

    render(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handle.url} onDoc={onDoc} />
      </Suspense>,
      { wrapper }
    )

    // Should show loading state initially
    expect(screen.getByTestId("loading")).toBeInTheDocument()

    // Eventually shows content after network delay
    await waitFor(() => {
      expect(screen.getByTestId("content")).toHaveTextContent("slow")
    })
    expect(onDoc).toHaveBeenCalledWith({ foo: "slow" })
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

  // Test document changes during loading
  it("should handle document changes while loading", async () => {
    const { wrapper, repoCreator } = setupPairedRepos()
    const onDoc = vi.fn()

    const handle = repoCreator.create({ foo: "initial" })

    render(
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <Component url={handle.url} onDoc={onDoc} />
      </Suspense>,
      { wrapper }
    )

    // Modify document while it's still loading
    handle.change(doc => (doc.foo = "changed"))

    // Should show final state
    await waitFor(() => {
      expect(screen.getByTestId("content")).toHaveTextContent("changed")
    })
    expect(onDoc).toHaveBeenCalledWith({ foo: "changed" })
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
