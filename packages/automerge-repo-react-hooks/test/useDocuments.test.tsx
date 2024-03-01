import { DocumentId, PeerId, Repo } from "@automerge/automerge-repo"
import { DummyStorageAdapter } from "@automerge/automerge-repo/test/helpers/DummyStorageAdapter"
import { act, renderHook, waitFor } from "@testing-library/react"
import React from "react"
import { describe, expect, it } from "vitest"
import { useDocuments } from "../src/useDocuments"
import { RepoContext } from "../src/useRepo"

describe("useDocuments", () => {
  const setup = () => {
    const repo = new Repo({
      peerId: "alice" as PeerId,
      network: [],
      storage: new DummyStorageAdapter(),
    })

    const wrapper = getRepoWrapper(repo)

    const documentIds = range(10).map(i => {
      const handle = repo.create({ foo: i })
      return handle.documentId
    })

    return { repo, wrapper, documentIds }
  }

  it("returns a collection of documents, given a list of ids", async () => {
    const { documentIds, wrapper } = setup()
    const { result } = renderHook(
      () => {
        const documents = useDocuments(documentIds)
        return { documents }
      },
      { wrapper }
    )

    await waitFor(() => {
      const { documents } = result.current
      documentIds.forEach((id, i) => expect(documents[id]).toEqual({ foo: i }))
    })
  })

  it("updates documents when they change", async () => {
    const { repo, documentIds, wrapper } = setup()

    const { result } = renderHook(
      () => {
        const documents = useDocuments(documentIds)
        return { documents }
      },
      { wrapper }
    )

    await waitFor(() => {
      const { documents } = result.current
      documentIds.forEach((id, i) => expect(documents[id]).toEqual({ foo: i }))
    })

    act(() => {
      // multiply the value of foo in each document by 10
      documentIds.forEach(id => {
        const handle = repo.find(id)
        handle.change(s => (s.foo *= 10))
      })
    })

    await waitFor(() => {
      const { documents } = result.current
      documentIds.forEach((id, i) =>
        expect(documents[id]).toEqual({ foo: i * 10 })
      )
    })
  })

  it(`removes documents when they're removed from the list of ids`, async () => {
    const { repo, documentIds, wrapper } = setup()
    const { result } = renderHook(
      () => {
        const [ids, setIds] = React.useState(documentIds)
        const documents = useDocuments(ids)
        return { documents, setIds }
      },
      { wrapper }
    )
    const [firstId, ...restIds] = documentIds

    await waitFor(() => {
      const { documents } = result.current
      expect(documents[firstId]).toEqual({ foo: 0 })
    })

    // remove the first document
    act(() => result.current.setIds(restIds))
    // 👆 Note that this only works because restIds is a different object from documentIds.
    // If we modified documentIds directly, the hook wouldn't re-run.

    await waitFor(() => {
      const { documents } = result.current
      expect(documents[firstId]).toBeUndefined()
    })
  })
})

const range = (n: number) => [...Array(n).keys()]

const getRepoWrapper =
  (repo: Repo) =>
  ({ children }) =>
    <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>

interface ExampleDoc {
  foo: number
}
