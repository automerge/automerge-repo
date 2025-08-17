import React, { act, Suspense } from "react"
import {
  AutomergeUrl,
  DocHandle,
  generateAutomergeUrl,
} from "@automerge/automerge-repo"
import { render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom"

import { describe, expect, it, vi } from "vitest"
import { ErrorBoundary } from "react-error-boundary"
import { setup, setupPairedRepos } from "./testSetup"
import { useDocHandles } from "../src/useDocHandles"
import { pause } from "../src/helpers/DummyNetworkAdapter"

describe("useDocHandles", () => {
  function mockOnHandles() {
    return vi.fn<
      (result: Map<AutomergeUrl, DocHandle<unknown> | undefined>) => void
    >()
  }

  describe("suspense", () => {
    const Component = ({
      urls,
      onHandles,
    }: {
      urls: AutomergeUrl[]
      onHandles: (
        handles: Map<AutomergeUrl, DocHandle<unknown> | undefined>
      ) => void
    }) => {
      const handle = useDocHandles(urls, { suspense: true })
      onHandles(handle)
      return null
    }

    it("loads some handles", async () => {
      const { handleA, handleB, wrapper } = setup()
      const onHandles = mockOnHandles()

      render(
        <Suspense fallback={null}>
          <Component urls={[handleA.url, handleB.url]} onHandles={onHandles} />
        </Suspense>,
        { wrapper }
      )

      const result = onHandles.mock.lastCall?.at(0)

      expect(result?.size).toBe(2)
      expect(result?.get(handleA.url)?.url).toEqual(handleA.url)
      expect(result?.get(handleB.url)?.url).toEqual(handleB.url)
    })

    it("updates the result map when the url changes", async () => {
      const { wrapper, handleA, handleB } = setup()
      const onHandles = mockOnHandles()

      const { rerender } = render(
        <Component urls={[handleA.url]} onHandles={onHandles} />,
        { wrapper }
      )

      const result1 = onHandles.mock.lastCall?.at(0)
      expect(result1?.size).toBe(1)
      expect(result1?.get(handleA.url)?.url).toEqual(handleA.url)

      rerender(<Component urls={[handleB.url]} onHandles={onHandles} />)

      await act(pause)

      const result2 = onHandles.mock.lastCall?.at(0)
      expect(result2?.size).toBe(1)
      expect(result2?.get(handleB.url)?.url).toEqual(handleB.url)
    })

    it("does not update the result map when the urls do not change", async () => {
      const { wrapper, handleA, handleB } = setup()
      const onHandles = mockOnHandles()

      const { rerender } = render(
        <Component urls={[handleA.url, handleB.url]} onHandles={onHandles} />,
        { wrapper }
      )

      const result1 = onHandles.mock.lastCall?.at(0)
      expect(result1?.size).toBe(2)
      expect(result1?.get(handleA.url)?.url).toEqual(handleA.url)
      expect(result1?.get(handleB.url)?.url).toEqual(handleB.url)

      rerender(
        <Component urls={[handleA.url, handleB.url]} onHandles={onHandles} />
      )

      await act(pause)

      const result2 = onHandles.mock.lastCall?.at(0)
      expect(result2).toBe(result1)
    })

    it("handles unavailable documents correctly", async () => {
      // suppress console.error from the error boundary
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

      const { handleA, wrapper } = setup()
      const noSuchDocUrl = generateAutomergeUrl()

      render(
        <ErrorBoundary fallback={<div data-testid="error">Error</div>}>
          <Suspense fallback={<div data-testid="loading">Loading...</div>}>
            <Component
              urls={[noSuchDocUrl, handleA.url]}
              onHandles={() => {
                throw new Error("Should not reach here")
              }}
            />
          </Suspense>
        </ErrorBoundary>,
        { wrapper }
      )

      await waitFor(() => {
        expect(screen.getByTestId("error")).toBeInTheDocument()
      })

      consoleSpy.mockRestore()
    })

    it("handles slow network correctly", async () => {
      const { repoCreator, wrapper } = setupPairedRepos()
      const handleA = repoCreator.create({ foo: "A" })
      const onHandles = mockOnHandles()

      render(
        <ErrorBoundary fallback={<div data-testid="error">Error</div>}>
          <Suspense fallback={<div data-testid="loading">Loading...</div>}>
            <Component urls={[handleA.url]} onHandles={onHandles} />
          </Suspense>
        </ErrorBoundary>,
        { wrapper }
      )

      // Verify loading state is shown initially
      expect(screen.getByTestId("loading")).toBeInTheDocument()
      expect(onHandles).not.toHaveBeenCalled()

      // Wait for successful resolution
      await waitFor(() => {
        // Loading state should be gone
        expect(screen.queryByTestId("loading")).not.toBeInTheDocument()
      })

      const result = onHandles.mock.lastCall?.at(0)
      expect(result?.size).toBe(1)
      expect(result?.get(handleA.url)?.url).toEqual(handleA.url)

      // Verify error boundary never rendered
      expect(screen.queryByTestId("error")).not.toBeInTheDocument()
    })

    it("suspends while loading a handle", async () => {
      const { repoCreator, wrapper } = await setupPairedRepos()
      const handleA = repoCreator.create({ foo: "A" })
      const onHandles = mockOnHandles()

      render(
        <Suspense fallback={<div data-testid="loading">Loading...</div>}>
          <Component urls={[handleA.url]} onHandles={onHandles} />
        </Suspense>,
        { wrapper }
      )

      // Should show loading state
      expect(screen.getByTestId("loading")).toBeInTheDocument()
      expect(onHandles).not.toHaveBeenCalled()

      // Should show content
      await waitFor(() => {
        expect(onHandles).toHaveBeenCalled()
      })

      const result = onHandles.mock.lastCall?.at(0)
      expect(result?.size).toBe(1)
      expect(result?.get(handleA.url)?.url).toEqual(handleA.url)
    })

    it("handles rapid url changes during loading", async () => {
      const { repoCreator, repoFinder, wrapper } = await setupPairedRepos()
      const handleA = repoCreator.create({ foo: "A" })
      const handleB = repoFinder.create({ foo: "B" })
      const onHandles = mockOnHandles()

      const { rerender } = render(
        <Suspense fallback={<div data-testid="loading">Loading...</div>}>
          <Component urls={[handleA.url]} onHandles={onHandles} />
        </Suspense>,
        { wrapper }
      )

      // Quickly switch to B before A loads
      rerender(
        <Suspense fallback={<div data-testid="loading">Loading...</div>}>
          <Component urls={[handleB.url]} onHandles={onHandles} />
        </Suspense>
      )

      // Should eventually resolve with B, not A
      await waitFor(() => {
        expect(onHandles).toHaveBeenCalled()
      })

      const result = onHandles.mock.lastCall?.at(0)
      expect(result?.size).toBe(1)
      expect(result?.get(handleB.url)?.url).toEqual(handleB.url)
    })
  })

  describe("useDocHandles with suspense: false", () => {
    function Component({
      urls,
      onHandles,
    }: {
      urls: AutomergeUrl[]
      onHandles: (
        handles: Map<AutomergeUrl, DocHandle<unknown> | undefined>
      ) => void
    }) {
      const handle = useDocHandles(urls, { suspense: false })
      onHandles(handle)
      return null
    }

    it("returns and empty map while loading then resolves to handle", async () => {
      const { repoCreator, wrapper } = await setupPairedRepos()
      const handleA = repoCreator.create({ foo: "A" })

      const onHandles = mockOnHandles()

      render(<Component urls={[handleA.url]} onHandles={onHandles} />, {
        wrapper,
      })

      const result1 = onHandles.mock.lastCall?.at(0)
      expect(result1?.size).toBe(0)

      // Wait for handle to load
      await waitFor(() => {
        expect(onHandles).toHaveBeenCalledWith(
          expect.objectContaining({ size: 1 })
        )
      })

      const result2 = onHandles.mock.lastCall?.at(0)
      expect(result2?.get(handleA.url)?.url).toEqual(handleA.url)
    })

    it("handles unavailable documents by omitting them", async () => {
      const { handleA, wrapper } = setup()
      const noSuchDocUrl = generateAutomergeUrl()
      const onHandles = mockOnHandles()

      render(
        <ErrorBoundary fallback={<div data-testid="error">Error</div>}>
          <Component urls={[handleA.url, noSuchDocUrl]} onHandles={onHandles} />
        </ErrorBoundary>,
        { wrapper }
      )

      const result = onHandles.mock.lastCall?.at(0)
      expect(result?.size).toBe(1)
      expect(result?.get(handleA.url)?.url).toEqual(handleA.url)
    })

    it("updates the handle map when urls change", async () => {
      const { wrapper, handleA, handleB } = setup()
      const onHandles = mockOnHandles()

      const { rerender } = render(
        <Component urls={[handleA.url]} onHandles={onHandles} />,
        { wrapper }
      )

      const result1 = onHandles.mock.lastCall?.at(0)
      expect(result1?.size).toBe(1)
      expect(result1?.get(handleA.url)?.url).toEqual(handleA.url)

      // Change URL
      rerender(<Component urls={[handleB.url]} onHandles={onHandles} />)
      await act(pause)

      const result2 = onHandles.mock.lastCall?.at(0)
      expect(result2?.size).toBe(1)
      expect(result2?.get(handleB.url)?.url).toEqual(handleB.url)
    })
  })
})
