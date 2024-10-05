import {
  AutomergeUrl,
  DocumentId,
  parseAutomergeUrl,
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

    const documentUrls = range(10).map(i => {
      const value = { foo: i }
      const handle = repo.create(value)
      documentValues[handle.documentId] = value
      return stringifyAutomergeUrl(handle.documentId)
    })

    return { repo, wrapper, documentUrls, documentValues }
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

  it("returns a collection of documents, given a list of urls", async () => {
    const { documentUrls, wrapper } = setup()
    const onDocs = vi.fn()

    render(<Component idsOrUrls={documentUrls} onDocs={onDocs} />, { wrapper })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((url, i) => [url, { foo: i }]))
      )
    )
  })

  it("returns a collection of loaded documents immediately, given a list of urls", async () => {
    const { documentUrls, wrapper } = setup()
    const onDocs = vi.fn()

    render(<Component idsOrUrls={documentUrls} onDocs={onDocs} />, { wrapper })

    expect(onDocs).not.toHaveBeenCalledWith({})
    expect(onDocs).toHaveBeenCalledWith(
      Object.fromEntries(documentUrls.map((id, i) => [id, { foo: i }]))
    )
  })

  it("cleans up listeners properly", async () => {
    const { documentUrls, wrapper, repo } = setup()
    const onDocs = vi.fn()

    // The goal here is to check that we're not leaking listeners.
    // We do this by mounting the component a set number of times and then
    // checking the number of listeners on the handle at the end.
    const numMounts = 5 // arbitrary number here
    for (let i = 0; i < numMounts; i++) {
      const { unmount } = render(
        <Component idsOrUrls={documentUrls} onDocs={onDocs} />,
        { wrapper }
      )
      await waitFor(() => unmount())
    }

    for (const url of documentUrls) {
      const handle = repo.find(url)

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
    const { repo, documentUrls, wrapper } = setup()
    const onDocs = vi.fn()

    render(<Component idsOrUrls={documentUrls} onDocs={onDocs} />, { wrapper })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((id, i) => [id, { foo: i }]))
      )
    )

    act(() => {
      // multiply the value of foo in each document by 10
      documentUrls.forEach(url => {
        const handle = repo.find(url)
        handle.change(s => (s.foo *= 10))
      })
    })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((id, i) => [id, { foo: i * 10 }]))
      )
    )
  })

  it("updates documents when they change, if ids are passed in", async () => {
    const { repo, documentUrls, wrapper } = setup()
    const onDocs = vi.fn()
    const documentIds = documentUrls.map(
      url => parseAutomergeUrl(url).documentId
    )

    render(<Component idsOrUrls={documentIds} onDocs={onDocs} />, { wrapper })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((url, i) => [url, { foo: i }]))
      )
    )

    act(() => {
      // multiply the value of foo in each document by 10
      documentUrls.forEach(url => {
        const handle = repo.find(url)
        handle.change(s => (s.foo *= 10))
      })
    })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((url, i) => [url, { foo: i * 10 }]))
      )
    )
  })

  it(`removes documents when they're removed from the list of URLs`, async () => {
    const { documentUrls, wrapper } = setup()
    const onDocs = vi.fn()

    const { rerender } = render(
      <Component idsOrUrls={documentUrls} onDocs={onDocs} />,
      { wrapper }
    )
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((id, i) => [id, { foo: i }]))
      )
    )

    // remove the first document
    rerender(<Component idsOrUrls={documentUrls.slice(1)} onDocs={onDocs} />)
    // 👆 Note that this only works because documentIds.slice(1) is a different
    // object from documentIds. If we modified documentIds directly, the hook
    // wouldn't re-run.
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(
          documentUrls.map((id, i) => [id, { foo: i }]).slice(1)
        )
      )
    )
  })

  it(`keeps updating documents after the list has changed`, async () => {
    const { documentUrls, wrapper, repo } = setup()
    const onDocs = vi.fn()

    const { rerender } = render(
      <Component idsOrUrls={documentUrls} onDocs={onDocs} />,
      { wrapper }
    )
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((url, i) => [url, { foo: i }]))
      )
    )

    // remove the first document
    act(() => {
      rerender(<Component idsOrUrls={documentUrls.slice(1)} onDocs={onDocs} />)
    })
    // 👆 Note that this only works because documentUrls.slice(1) is a different
    // object from documentUrls. If we modified documentUrls directly, the hook
    // wouldn't re-run.
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(
          documentUrls.map((url, i) => [url, { foo: i }]).slice(1)
        )
      )
    )

    // update all the docs that are still in the list

    act(() => {
      // multiply the value of foo in each document by 10
      documentUrls.slice(1).forEach(url => {
        const handle = repo.find(url)
        handle.change(s => (s.foo *= 10))
      })
    })

    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(
          documentUrls.map((url, i) => [url, { foo: i * 10 }]).slice(1)
        )
      )
    )

    act(() => {
      // multiply the value of foo in each document by 10
      documentUrls.slice(1).forEach(url => {
        const handle = repo.find(url)
        handle.change(s => (s.foo *= 10))
      })
    })

    await waitFor(() => {
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(
          documentUrls.map((url, i) => [url, { foo: i * 100 }]).slice(1)
        )
      )
    })
  })
})

const range = (n: number) => [...Array(n).keys()]
