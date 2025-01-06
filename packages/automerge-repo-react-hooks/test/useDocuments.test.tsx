import React, { Suspense, act } from "react"
import {
  AutomergeUrl,
  DocHandle,
  Repo,
  PeerId,
} from "@automerge/automerge-repo"
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useDocuments } from "../src/useDocuments"
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

describe("Document Hooks", () => {
  const repo = new Repo({
    peerId: "bob" as PeerId,
  })

  function setup() {
    const handleA = repo.create<ExampleDoc>()
    handleA.change(doc => (doc.foo = "A"))

    const handleB = repo.create<ExampleDoc>()
    handleB.change(doc => (doc.foo = "B"))

    const handleC = repo.create<ExampleDoc>()
    handleB.change(doc => (doc.foo = "B"))

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

  describe("useDocHandles", () => {
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

      await act(async () => {
        render(
          <ErrorBoundary fallback={<div>error</div>}>
            <Suspense fallback={null}>
              <HandlesComponent urls={urls} onHandles={onHandles} />
            </Suspense>
          </ErrorBoundary>,

          { wrapper }
        )
      })

      await waitFor(() => {
        const lastCall = onHandles.mock.lastCall[0]
        expect(lastCall.size).toBe(3)
        expect(lastCall.get(handleA.url)).toBeDefined()
        expect(lastCall.get(handleB.url)).toBeDefined()
        expect(lastCall.get(handleC.url)).toBeDefined()
      })
    })

    it("should handle document removal", async () => {
      const { handleA, handleB, wrapper } = setup()
      const onHandles = vi.fn()

      const { rerender } = render(
        <Suspense fallback={null}>
          <HandlesComponent
            urls={[handleA.url, handleB.url]}
            onHandles={onHandles}
          />
        </Suspense>,
        { wrapper }
      )

      await waitFor(() => {
        expect(onHandles.mock.lastCall[0].size).toBe(2)
      })

      // Remove one document
      rerender(
        <Suspense fallback={null}>
          <HandlesComponent urls={[handleA.url]} onHandles={onHandles} />
        </Suspense>
      )

      await waitFor(() => {
        const lastCall = onHandles.mock.lastCall[0]
        expect(lastCall.size).toBe(1)
        expect(lastCall.has(handleA.url)).toBe(true)
        expect(lastCall.has(handleB.url)).toBe(false)
      })
    })
  })

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

      render(
        <Suspense fallback={null}>
          <DocumentsComponent urls={[handleA.url]} onState={onState} />
        </Suspense>,
        { wrapper }
      )

      // Wait for initial sync
      await waitFor(() => {
        const [docs] = onState.mock.lastCall
        expect(docs.get(handleA.url)?.foo).toBe("A")
      })

      // Make a change
      const [, change] = onState.mock.lastCall
      change(handleA.url, doc => (doc.foo = "Changed"))

      // Verify change was synced
      await waitFor(() => {
        const [docs] = onState.mock.lastCall
        expect(docs.get(handleA.url)?.foo).toBe("Changed")
      })
    })

    it("should handle multiple documents", async () => {
      const { handleA, handleB, wrapper } = setup()
      const onState = vi.fn()

      render(
        <Suspense fallback={null}>
          <DocumentsComponent
            urls={[handleA.url, handleB.url]}
            onState={onState}
          />
        </Suspense>,
        { wrapper }
      )

      await waitFor(() => {
        const [docs] = onState.mock.lastCall
        expect(docs.get(handleA.url)?.foo).toBe("A")
        expect(docs.get(handleB.url)?.foo).toBe("B")
      })
    })
  })
})
