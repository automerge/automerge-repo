import { PeerId, Repo, AutomergeUrl } from "@automerge/automerge-repo"
import { DummyStorageAdapter } from "@automerge/automerge-repo/test/helpers/DummyStorageAdapter"
import { describe, it } from "vitest"
import { RepoContext } from "../src/useRepo"
import { useHandle } from "../src/useHandle"
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

describe("useHandle", () => {
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

  it("loads a handle", async () => {
    const { handleA, wrapper } = setup()

    const { result, waitForNextUpdate } = renderHook(
      () => {
        const handle = useHandle(handleA.url)

        return {
          handle,
        }
      },
      { wrapper }
    )

    assert.deepStrictEqual(result.current.handle, handleA)
  })

  it("returns undefined when no url given", async () => {
    const { handleA, wrapper } = setup()

    const { result, waitForNextUpdate } = renderHook(
      () => {
        const handle = useHandle()

        return {
          handle,
        }
      },
      { wrapper }
    )

    assert.deepStrictEqual(result.current.handle, undefined)
  })

  it("updates the handle when the url changes", async () => {
    const { wrapper, handleA, handleB } = setup()

    const { result, waitForNextUpdate } = renderHook(
      () => {
        const [url, setUrl] = useState<AutomergeUrl>()
        const handle = useHandle(url)

        return {
          setUrl,
          handle,
        }
      },
      { wrapper }
    )

    // initially doc is undefined
    assert.deepStrictEqual(result.current.handle, undefined)

    // set url to doc A
    result.current.setUrl(handleA.url)
    await waitForNextUpdate()
    assert.deepStrictEqual(result.current.handle, handleA)

    // set url to doc B
    result.current.setUrl(handleB.url)
    await waitForNextUpdate()
    assert.deepStrictEqual(result.current.handle, handleB)

    // set url to undefined
    result.current.setUrl(undefined)
    await waitForNextUpdate()
    assert.deepStrictEqual(result.current.handle, undefined)
  })
})
