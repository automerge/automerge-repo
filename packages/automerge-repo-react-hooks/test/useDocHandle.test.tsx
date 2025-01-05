import React, { Suspense } from "react"
import {
  AutomergeUrl,
  DocHandle,
  PeerId,
  Repo,
} from "@automerge/automerge-repo"
import { render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useDocHandle } from "../src/useDocHandle"
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
    onHandle: (handle: DocHandle<unknown>) => void
  }) => {
    const handle = useDocHandle(url)
    onHandle(handle)
    return null
  }

  it("loads a handle", async () => {
    const { handleA, wrapper } = setup()
    const onHandle = vi.fn()

    render(
      <Suspense fallback={null}>
        <Component url={handleA.url} onHandle={onHandle} />
      </Suspense>,
      { wrapper }
    )
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))
  })

  it("updates the handle when the url changes", async () => {
    const { wrapper, handleA, handleB } = setup()
    const onHandle = vi.fn()

    const { rerender } = render(
      <Component url={handleA.url} onHandle={onHandle} />,
      { wrapper }
    )
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))

    // set url to doc B
    rerender(<Component url={handleB.url} onHandle={onHandle} />)
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleB))
  })

  it("does not return undefined after the url is updated", async () => {
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
    await waitFor(() => expect(onHandle2).not.toHaveBeenCalledWith(undefined))
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
