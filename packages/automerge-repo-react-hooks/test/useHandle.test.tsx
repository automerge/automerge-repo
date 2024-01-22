import { PeerId, Repo, AutomergeUrl } from "@automerge/automerge-repo"
import { DummyStorageAdapter } from "@automerge/automerge-repo/test/helpers/DummyStorageAdapter"
import { describe, expect, it } from "vitest"
import { RepoContext } from "../src/useRepo"
import { useHandle } from "../src/useHandle"
import { act, renderHook, waitFor } from "@testing-library/react"
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

    const { result } = await act(() =>
      renderHook(
        () => {
          const handle = useHandle(handleA.url)
          return { handle }
        },
        { wrapper }
      )
    )

    assert.deepStrictEqual(result.current.handle, handleA)
  })

  it("returns undefined when no url given", async () => {
    const { wrapper } = setup()

    const { result } = await act(() =>
      renderHook(
        () => {
          const handle = useHandle()
          return { handle }
        },
        { wrapper }
      )
    )

    await waitFor(() => expect(result.current.handle).toBeUndefined())
  })

  it("updates the handle when the url changes", async () => {
    const { wrapper, handleA, handleB } = setup()

    const { result } = await act(() =>
      renderHook(
        () => {
          const [url, setUrl] = useState<AutomergeUrl>()
          const handle = useHandle(url)
          return { setUrl, handle }
        },
        { wrapper }
      )
    )

    await waitFor(() => expect(result.current).not.toBeNull())

    // set url to doc A
    act(() => result.current.setUrl(handleA.url))
    await waitFor(() => expect(result.current.handle).toMatchObject(handleA))

    // set url to doc B
    act(() => result.current.setUrl(handleB.url))
    await waitFor(() => expect(result.current.handle).toMatchObject(handleB))

    // set url to undefined
    act(() => result.current.setUrl(undefined))
    await waitFor(() => expect(result.current.handle).toBeUndefined())
  })
})
