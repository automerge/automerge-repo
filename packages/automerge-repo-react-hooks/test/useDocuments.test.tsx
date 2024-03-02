import { DocumentId, PeerId, Repo } from "@automerge/automerge-repo"
import { DummyStorageAdapter } from "@automerge/automerge-repo/test/helpers/DummyStorageAdapter"
import { act, render, waitFor } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { useDocuments } from "../src/useDocuments"
import { RepoContext } from "../src/useRepo"

describe("useDocuments", () => {
  const setup = () => {
    const repo = new Repo({
      peerId: "alice" as PeerId,
      network: [],
      storage: new DummyStorageAdapter(),
    })

    const wrapper = ({ children }) => {
      return <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>
    }

    let documentValues: Record<string, any> = {}

    const documentIds = range(10).map(i => {
      const value = { foo: i }
      const handle = repo.create(value)
      documentValues[handle.documentId] = value
      return handle.documentId
    })

    return { repo, wrapper, documentIds, documentValues }
  }

  const Component = ({ ids, onDocs }: {
    ids: DocumentId[],
    onDocs: (documents: Record<DocumentId, unknown>) => void,
  }) => {
    const documents = useDocuments(ids)
    onDocs(documents)
    return null
  }

  it("returns a collection of documents, given a list of ids", async () => {
    const { documentIds, documentValues, wrapper } = setup()
    const onDocs = vi.fn()

    render(<Component ids={documentIds} onDocs={onDocs} />, { wrapper })
    await waitFor(() => expect(onDocs).toHaveBeenCalledWith(documentValues))
  })

  it("updates documents when they change", async () => {
    const { repo, documentIds, documentValues, wrapper } = setup()
    const onDocs = vi.fn()

    render(<Component ids={documentIds} onDocs={onDocs} />, { wrapper })
    await waitFor(() => expect(onDocs).toHaveBeenCalledWith(documentValues))

    act(() => {
      // multiply the value of foo in each document by 10
      documentIds.forEach(id => {
        const handle = repo.find(id)
        handle.change(s => (s.foo *= 10))
      })
    })
    await waitFor(() => expect(onDocs).toHaveBeenCalledWith(
      Object.fromEntries(Object.entries(documentValues).map(
        ([k, { foo }]) => [k, { foo: foo * 10 }]
      ))
    ))
  })

  it("updates documents when one is deleted", async () => {
    const { repo, documentIds, documentValues, wrapper } = setup()
    const onDocs = vi.fn()

    render(<Component ids={documentIds} onDocs={onDocs} />, { wrapper })

    // delete the first document
    act(() => {
      const handle = repo.find(documentIds[0])
      handle.delete()
    })

    await waitFor(() => expect(onDocs).toHaveBeenCalledWith(
      { ...documentValues, [documentIds[0]]: undefined }
    ))
  })

  it(`removes documents when they're removed from the list of ids`, async () => {
    const { documentIds, documentValues, wrapper } = setup()
    const onDocs = vi.fn()

    const { rerender } = render(<Component ids={documentIds} onDocs={onDocs} />, { wrapper })
    await waitFor(() => expect(onDocs).toHaveBeenCalledWith(documentValues))

    // remove the first document
    rerender(<Component ids={documentIds.slice(1)} onDocs={onDocs} />)
    // 👆 Note that this only works because documentIds.slice(1) is a different
    // object from documentIds. If we modified documentIds directly, the hook
    // wouldn't re-run.
    await waitFor(() => expect(onDocs).toHaveBeenCalledWith(
      { ...documentValues, [documentIds[0]]: undefined }
    ))
  })
})

const range = (n: number) => [...Array(n).keys()]

interface ExampleDoc {
  foo: number
}
