import { AutomergeUrl, PeerId, Repo } from "@automerge/automerge-repo"
import { DummyStorageAdapter } from "@automerge/automerge-repo/test/helpers/DummyStorageAdapter"
import { renderHook, waitFor } from "@testing-library/react"
import React, { useState } from "react"
import { act } from "react-dom/test-utils"
import { describe, expect, it } from "vitest"
import { useDocument } from "../src/useDocument"
import { RepoContext } from "../src/useRepo"

const SLOW_DOC_LOAD_TIME_MS = 10

describe("useDocument", () => {
  const repo = new Repo({
    peerId: "bob" as PeerId,
    network: [],
    storage: new DummyStorageAdapter(),
  })

  function setup() {
    const handleA = repo.create<ExampleDoc>()
    handleA.change(doc => (doc.foo = "A"))

    const handleB = repo.create<ExampleDoc>()
    handleB.change(doc => (doc.foo = "B"))

    // A doc that takes 10ms to load, to simulate a slow load.
    // The time value isn't totally arbitrary; 1ms can cause flaky tests
    // presumably because of interations with React's scheduler / batched
    // renders, but 10ms seems safe empirically.
    const handleSlow = repo.create<ExampleDoc>()
    handleSlow.change(doc => (doc.foo = "slow"))
    const oldDoc = handleSlow.doc.bind(handleSlow)
    handleSlow.doc = async () => {
      await new Promise(resolve => setTimeout(resolve, SLOW_DOC_LOAD_TIME_MS))
      const result = await oldDoc()
      return result
    }

    return {
      repo,
      handleA,
      handleB,
      handleSlow,
      wrapper: getRepoWrapper(repo),
    }
  }

  it("should load a document", async () => {
    const { handleA, wrapper } = setup()

    const { result } = renderHook(() => useDocument(handleA.url), { wrapper })

    await waitFor(() => {
      const [doc] = result.current
      expect(doc).toEqual({ foo: "A" })
    })
  })

  it("should update if the url changes", async () => {
    const { wrapper, handleA, handleB } = setup()

    const { result } = await act(() =>
      renderHook(
        () => {
          const [url, setUrl] = useState<AutomergeUrl>()
          const [doc] = useDocument(url)
          return { setUrl, doc }
        },
        { wrapper }
      )
    )

    await waitFor(() => expect(result.current).not.toBeNull())

    // set url to doc A
    act(() => result.current.setUrl(handleA.url))
    await waitFor(() => expect(result.current.doc).toEqual({ foo: "A" }))

    // set url to doc B
    act(() => result.current.setUrl(handleB.url))
    await waitFor(() => expect(result.current.doc).toEqual({ foo: "B" }))

    // set url to undefined
    act(() => result.current.setUrl(undefined))
    await waitFor(() => expect(result.current.doc).toBeUndefined())
  })

  it("sets the doc to undefined while the initial load is happening", async () => {
    const { wrapper, handleA, handleSlow } = setup()

    const { result } = await act(() =>
      renderHook(
        () => {
          const [url, setUrl] = useState<AutomergeUrl>()
          const [doc] = useDocument(url)
          return { setUrl, doc }
        },
        { wrapper }
      )
    )

    await waitFor(() => expect(result.current).not.toBeNull())

    // start by setting url to doc A
    act(() => result.current.setUrl(handleA.url))
    await waitFor(() => expect(result.current.doc).toEqual({ foo: "A" }))

    // Now we set the URL to a handle that's slow to load.
    // The doc should be undefined while the load is happening.
    act(() => result.current.setUrl(handleSlow.url))
    await waitFor(() => expect(result.current.doc).toBeUndefined())
    await waitFor(() => expect(result.current.doc).toEqual({ foo: "slow" }))
  })

  it("avoids showing stale data", async () => {
    const { wrapper, handleA, handleSlow } = setup()
    const { result } = await act(() =>
      renderHook(
        () => {
          const [url, setUrl] = useState<AutomergeUrl>()
          const [doc] = useDocument(url)
          return { setUrl, doc }
        },
        { wrapper }
      )
    )

    await waitFor(() => expect(result.current).not.toBeNull())

    // Set the URL to a slow doc and then a fast doc.
    // We should see the fast doc forever, even after
    // the slow doc has had time to finish loading.
    act(() => {
      result.current.setUrl(handleSlow.url)
      result.current.setUrl(handleA.url)
    })
    await waitFor(() => expect(result.current.doc).toEqual({ foo: "A" }))

    // wait for the slow doc to finish loading...
    await pause(SLOW_DOC_LOAD_TIME_MS * 2)

    // we didn't update the doc to the slow doc, so it should still be A
    await waitFor(() => expect(result.current.doc).toEqual({ foo: "A" }))
  })
})

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const getRepoWrapper =
  (repo: Repo) =>
  ({ children }) =>
    <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>

interface ExampleDoc {
  foo: string
}
