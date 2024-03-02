import { AutomergeUrl, PeerId, Repo } from "@automerge/automerge-repo"
import { DummyStorageAdapter } from "@automerge/automerge-repo/test/helpers/DummyStorageAdapter"
import { render, waitFor } from "@testing-library/react"
import React from "react"
import { act } from "react-dom/test-utils"
import { describe, expect, it, vi } from "vitest"
import { useDocument } from "../src/useDocument"
import { RepoContext } from "../src/useRepo"

const SLOW_DOC_LOAD_TIME_MS = 10

describe("useDocument", () => {
  function setup() {
    const repo = new Repo({
      peerId: "bob" as PeerId,
      network: [],
      storage: new DummyStorageAdapter(),
    })

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

    const wrapper = ({ children }) => {
      return <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>
    }

    return {
      repo,
      handleA,
      handleB,
      handleSlow,
      wrapper,
    }
  }

  const Component = ({ url, onDoc }: {
    url: AutomergeUrl,
    onDoc: (doc: ExampleDoc) => void,
  }) => {
    const [doc] = useDocument(url)
    onDoc(doc)
    return null
  }

  it("should load a document", async () => {
    const { handleA, wrapper } = setup()
    const onDoc = vi.fn()

    render(<Component url={handleA.url} onDoc={onDoc} />, {wrapper})
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith({ foo: "A" }))
  })

  it("should update if the doc changes", async () => {
    const { wrapper, handleA } = setup()
    const onDoc = vi.fn()

    render(<Component url={handleA.url} onDoc={onDoc} />, {wrapper})
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith({ foo: "A" }))

    act(() => handleA.change(doc => (doc.foo = "new value")))
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith({ foo: "new value" }))
  });

  it("should update if the doc is deleted", async () => {
    const { wrapper, handleA } = setup()
    const onDoc = vi.fn()

    render(<Component url={handleA.url} onDoc={onDoc} />, {wrapper})
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith({ foo: "A" }))

    act(() => handleA.delete())
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith(undefined))
  });

  it("should update if the url changes", async () => {
    const { handleA, handleB, wrapper } = setup()
    const onDoc = vi.fn()

    const { rerender } = render(<Component url={undefined} onDoc={onDoc} />, {wrapper})
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith(undefined))

    // set url to doc A
    rerender(<Component url={handleA.url} onDoc={onDoc} />)
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith({ foo: "A" }))

    // set url to doc B
    rerender(<Component url={handleB.url} onDoc={onDoc} />)
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith({ foo: "B" }))

    // set url to undefined
    rerender(<Component url={undefined} onDoc={onDoc} />)
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith(undefined))
  })

  it("sets the doc to undefined while the initial load is happening", async () => {
    const { handleA, handleSlow, wrapper } = setup()
    const onDoc = vi.fn()

    const { rerender } = render(<Component url={undefined} onDoc={onDoc} />, {wrapper})
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith(undefined))

    // start by setting url to doc A
    rerender(<Component url={handleA.url} onDoc={onDoc} />)
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith({ foo: "A" }))

    // Now we set the URL to a handle that's slow to load.
    // The doc should be undefined while the load is happening.
    rerender(<Component url={handleSlow.url} onDoc={onDoc} />)
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith(undefined))
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith({ foo: "slow" }))
  })

  it("avoids showing stale data", async () => {
    const { handleA, handleSlow, wrapper } = setup()
    const onDoc = vi.fn()

    const { rerender } = render(<Component url={undefined} onDoc={onDoc} />, {wrapper})
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith(undefined))

    // Set the URL to a slow doc and then a fast doc.
    // We should see the fast doc forever, even after
    // the slow doc has had time to finish loading.
    rerender(<Component url={handleSlow.url} onDoc={onDoc} />)
    rerender(<Component url={handleA.url} onDoc={onDoc} />)
    await waitFor(() => expect(onDoc).toHaveBeenLastCalledWith({ foo: "A" }))

    // wait for the slow doc to finish loading...
    await pause(SLOW_DOC_LOAD_TIME_MS * 2)

    // we didn't update the doc to the slow doc, so it should still be A
    expect(onDoc).not.toHaveBeenCalledWith({ foo: "slow" })
  })
})

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface ExampleDoc {
  foo: string
}
