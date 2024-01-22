import { PeerId, Repo, AutomergeUrl } from "@automerge/automerge-repo"
import { DummyStorageAdapter } from "@automerge/automerge-repo/test/helpers/DummyStorageAdapter"
import { describe, it } from "vitest"
import { RepoContext } from "../src/useRepo"
import { useDocument } from "../src/useDocument"
import { renderHook } from "@testing-library/react-hooks"
import React, { useState } from "react"
import assert from "assert"

interface ExampleDoc {
  foo: string
}

function getRepoWrapper(repo: Repo) {
  return ({ children }) => (
    <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>
  )
}

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

    const { result, waitForNextUpdate } = renderHook(
      () => useDocument(handleA.url),
      { wrapper }
    )

    await waitForNextUpdate()

    const [doc] = result.current

    assert.deepStrictEqual(doc, { foo: "A" })
  })

  it("should update if the url changes", async () => {
    const { wrapper, handleA, handleB } = setup()

    const { result, waitForNextUpdate } = renderHook(
      () => {
        const [url, setUrl] = useState<AutomergeUrl>()
        const [doc] = useDocument(url)

        return {
          setUrl,
          doc,
        }
      },
      { wrapper }
    )

    // initially doc is undefined
    assert.deepStrictEqual(result.current.doc, undefined)

    // set url to doc A
    result.current.setUrl(handleA.url)
    await waitForNextUpdate()
    assert.deepStrictEqual(result.current.doc, { foo: "A" })

    // set url to doc B
    result.current.setUrl(handleB.url)
    await waitForNextUpdate()
    assert.deepStrictEqual(result.current.doc, { foo: "B" })

    // set url to undefined
    result.current.setUrl(undefined)
    await waitForNextUpdate()
    assert.deepStrictEqual(result.current.doc, undefined)
  })

  it("sets the doc to undefined while the initial load is happening", async () => {
    const { wrapper, handleA, handleSlow } = setup()

    const { result, waitForNextUpdate, waitFor } = renderHook(
      () => {
        const [url, setUrl] = useState<AutomergeUrl>()
        const [doc] = useDocument(url)

        return {
          setUrl,
          doc,
        }
      },
      { wrapper }
    )

    // initially doc is undefined
    assert.deepStrictEqual(result.current.doc, undefined)

    // start by setting url to doc A
    result.current.setUrl(handleA.url)
    await waitForNextUpdate()
    assert.deepStrictEqual(result.current.doc, { foo: "A" })

    // Now we set the URL to a handle that's slow to load.
    // The doc should be undefined while the load is happening.
    result.current.setUrl(handleSlow.url)
    await waitForNextUpdate()
    assert.deepStrictEqual(result.current.doc, undefined)
    await waitForNextUpdate()
    assert.deepStrictEqual(result.current.doc, { foo: "slow" })
  })

  it("avoids showing stale data", async () => {
    const { wrapper, handleA, handleSlow } = setup()

    const { result, waitForNextUpdate, waitFor } = renderHook(
      () => {
        const [url, setUrl] = useState<AutomergeUrl>()
        const [doc] = useDocument(url)

        return {
          setUrl,
          doc,
        }
      },
      { wrapper }
    )

    // initially doc is undefined
    assert.deepStrictEqual(result.current.doc, undefined)

    // Set the URL to a slow doc and then a fast doc.
    // We should see the fast doc forever, even after
    // the slow doc has had time to finish loading.
    result.current.setUrl(handleSlow.url)
    result.current.setUrl(handleA.url)
    await waitForNextUpdate()
    assert.deepStrictEqual(result.current.doc, { foo: "A" })

    // wait for the slow doc to finish loading...
    await new Promise(resolve => setTimeout(resolve, SLOW_DOC_LOAD_TIME_MS * 2))

    // we didn't update the doc to the slow doc, so it should still be A
    assert.deepStrictEqual(result.current.doc, { foo: "A" })
  })
})
