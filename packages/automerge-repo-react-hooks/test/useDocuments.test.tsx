import {
  AutomergeUrl,
  DocumentId,
  PeerId,
  Repo,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo"
import { DummyStorageAdapter } from "@automerge/automerge-repo/helpers/DummyStorageAdapter.js"
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
      return (
        <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>
      )
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

  const Component = ({
    idsOrUrls,
    onDocs,
  }: {
    idsOrUrls: (DocumentId | AutomergeUrl)[]
    onDocs: (documents: Record<DocumentId, unknown>) => void
  }) => {
    const documents = useDocuments(idsOrUrls)
    onDocs(documents)
    return null
  }

  it("returns a collection of documents, given a list of ids", async () => {
    const { documentIds, wrapper } = setup()
    const onDocs = vi.fn()

    render(<Component idsOrUrls={documentIds} onDocs={onDocs} />, { wrapper })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentIds.map((id, i) => [id, { foo: i }]))
      )
    )
  })

  it("returns a collection of loaded documents immediately, given a list of ids", async () => {
    const { documentIds, wrapper } = setup()
    const onDocs = vi.fn()

    render(<Component idsOrUrls={documentIds} onDocs={onDocs} />, { wrapper })

    expect(onDocs).not.toHaveBeenCalledWith({})
    expect(onDocs).toHaveBeenCalledWith(
      Object.fromEntries(documentIds.map((id, i) => [id, { foo: i }]))
    )
  })

  it("cleans up listeners properly", async () => {
    const { documentIds, wrapper, repo } = setup()
    const onDocs = vi.fn()

    // The goal here is to check that we're not leaking listeners.
    // We do this by mounting the component a set number of times and then
    // checking the number of listeners on the handle at the end.
    const numMounts = 5 // arbitrary number here
    for (let i = 0; i < numMounts; i++) {
      const { unmount } = render(
        <Component idsOrUrls={documentIds} onDocs={onDocs} />,
        { wrapper }
      )
      await waitFor(() => unmount())
    }

    for (const id of documentIds) {
      const handle = repo.find(id)

      // You might expect we'd check that it's equal to 0 here.
      // but it turns out that automerge-repo registers an internal
      // change handler which remain on the doc even after unmount,
      // so we can't do that.
      // By comparing to numMounts, we ensure that if mount+unmount
      // does leak a listener, it'll fail this test.
      expect(handle.listenerCount("change")).toBeLessThan(numMounts)
    }
  })

  it("updates documents when they change", async () => {
    const { repo, documentIds, wrapper } = setup()
    const onDocs = vi.fn()

    render(<Component idsOrUrls={documentIds} onDocs={onDocs} />, { wrapper })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentIds.map((id, i) => [id, { foo: i }]))
      )
    )

    act(() => {
      // multiply the value of foo in each document by 10
      documentIds.forEach(id => {
        const handle = repo.find(id)
        handle.change(s => (s.foo *= 10))
      })
    })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentIds.map((id, i) => [id, { foo: i * 10 }]))
      )
    )
  })

  it("updates documents when they change, if URLs are passed in", async () => {
    const { repo, documentIds, wrapper } = setup()
    const onDocs = vi.fn()
    const documentUrls = documentIds.map(id => stringifyAutomergeUrl(id))

    render(<Component idsOrUrls={documentUrls} onDocs={onDocs} />, { wrapper })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentIds.map((id, i) => [id, { foo: i }]))
      )
    )

    act(() => {
      // multiply the value of foo in each document by 10
      documentIds.forEach(id => {
        const handle = repo.find(id)
        handle.change(s => (s.foo *= 10))
      })
    })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentIds.map((id, i) => [id, { foo: i * 10 }]))
      )
    )
  })

  it(`removes documents when they're removed from the list of ids`, async () => {
    const { documentIds, wrapper } = setup()
    const onDocs = vi.fn()

    const { rerender } = render(
      <Component idsOrUrls={documentIds} onDocs={onDocs} />,
      { wrapper }
    )
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentIds.map((id, i) => [id, { foo: i }]))
      )
    )

    // remove the first document
    rerender(<Component idsOrUrls={documentIds.slice(1)} onDocs={onDocs} />)
    // 👆 Note that this only works because documentIds.slice(1) is a different
    // object from documentIds. If we modified documentIds directly, the hook
    // wouldn't re-run.
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(
          documentIds.map((id, i) => [id, { foo: i }]).slice(1)
        )
      )
    )
  })

  it(`keeps updating documents after the list has changed`, async () => {
    const { documentIds, wrapper, repo } = setup()
    const onDocs = vi.fn()

    const { rerender } = render(
      <Component idsOrUrls={documentIds} onDocs={onDocs} />,
      { wrapper }
    )
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentIds.map((id, i) => [id, { foo: i }]))
      )
    )

    // remove the first document
    act(() => {
      rerender(<Component idsOrUrls={documentIds.slice(1)} onDocs={onDocs} />)
    })
    // 👆 Note that this only works because documentIds.slice(1) is a different
    // object from documentIds. If we modified documentIds directly, the hook
    // wouldn't re-run.
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(
          documentIds.map((id, i) => [id, { foo: i }]).slice(1)
        )
      )
    )

    // update all the docs that are still in the list

    act(() => {
      // multiply the value of foo in each document by 10
      documentIds.slice(1).forEach(id => {
        const handle = repo.find(id)
        handle.change(s => (s.foo *= 10))
      })
    })

    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(
          documentIds.map((id, i) => [id, { foo: i * 10 }]).slice(1)
        )
      )
    )

    act(() => {
      // multiply the value of foo in each document by 10
      documentIds.slice(1).forEach(id => {
        const handle = repo.find(id)
        handle.change(s => (s.foo *= 10))
      })
    })

    await waitFor(() => {
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(
          documentIds.map((id, i) => [id, { foo: i * 100 }]).slice(1)
        )
      )
    })
  })
})

const range = (n: number) => [...Array(n).keys()]
