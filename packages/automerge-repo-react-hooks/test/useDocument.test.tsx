import { AutomergeUrl, PeerId, Repo } from "@automerge/automerge-repo"
import { render, screen, waitFor } from "@testing-library/react"
import React, { Suspense } from "react"
import { describe, expect, it, vi } from "vitest"
import { useDocument } from "../src/useDocument"
import { RepoContext } from "../src/useRepo"

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

    const wrapper = ({ children }) => {
      return (
        <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>
      )
    }

    return {
      repo,
      handleA,
      handleB,
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

    // First we should see the loading state
    expect(screen.getByTestId("loading")).toBeInTheDocument()

    // Wait for content to appear and check it's correct
    await waitFor(() => {
      expect(screen.getByTestId("content")).toHaveTextContent("A")
    })

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
      <ErrorBoundary onError={onError}>
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
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.any(Error))
    })
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
})

class ErrorBoundary extends React.Component<
  { children: React.ReactNode; onError: (error: Error) => void },
  { hasError: boolean }
> {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error) {
    this.props.onError(error)
  }

  render() {
    if (this.state.hasError) {
      return null
    }
    return this.props.children
  }
}
