import {
  AutomergeUrl,
  DocHandle,
  PeerId,
  Repo,
} from "@automerge/automerge-repo"
import { DummyStorageAdapter } from "@automerge/automerge-repo/test/helpers/DummyStorageAdapter"
import { render, waitFor } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { useHandle } from "../src/useHandle"
import { RepoContext } from "../src/useRepo"

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

  const Component = ({
    url,
    onHandle,
  }: {
    url: AutomergeUrl
    onHandle: (handle: DocHandle<unknown> | undefined) => void
  }) => {
    const handle = useHandle(url)
    onHandle(handle)
    return null
  }

  it("loads a handle", async () => {
    const { handleA, wrapper } = setup()
    const onHandle = vi.fn()

    render(<Component url={handleA.url} onHandle={onHandle} />, { wrapper })
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))
  })

  it("returns undefined when no url given", async () => {
    const { wrapper } = setup()
    const onHandle = vi.fn()

    render(<Component url={undefined} onHandle={onHandle} />, { wrapper })
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(undefined))
  })

  it("updates the handle when the url changes", async () => {
    const { wrapper, handleA, handleB } = setup()
    const onHandle = vi.fn()

    const { rerender } = render(
      <Component url={undefined} onHandle={onHandle} />,
      { wrapper }
    )
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(undefined))

    // set url to doc A
    rerender(<Component url={handleA.url} onHandle={onHandle} />)
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))

    // set url to doc B
    rerender(<Component url={handleB.url} onHandle={onHandle} />)
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleB))

    // set url to undefined
    rerender(<Component url={undefined} onHandle={onHandle} />)
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(undefined))
  })

  it("does not return a handle for a different url after the url is updated", async () => {
    const { wrapper, handleA, handleB } = setup()
    const onHandle = vi.fn()

    const { rerender } = render(
      <Component url={handleA.url} onHandle={onHandle} />,
      { wrapper }
    )
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))

    const onHandle2 = vi.fn()

    // set url to doc B
    rerender(<Component url={handleB.url} onHandle={onHandle2} />)
    await waitFor(() => expect(onHandle2).not.toHaveBeenCalledWith(handleA))
  })
})
