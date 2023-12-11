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

    return {
      repo,
      handleA,
      handleB,
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
})
