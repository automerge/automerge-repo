import {
  AutomergeUrl,
  DocumentId,
  PeerId,
  Repo,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo"
import { DummyStorageAdapter } from "@automerge/automerge-repo/helpers/DummyStorageAdapter.js"
import { render, waitFor } from "@testing-library/react"
import React, { Suspense } from "react"
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
      documentValues[handle.url] = value
      return handle.url
    })

    return { repo, wrapper, documentUrls, documentValues }
  }

  const Component = ({
    urls,
    onDocs,
  }: {
    urls: AutomergeUrl[]
    onDocs: (documents: Record<DocumentId, unknown>) => void
  }) => {
    const documents = useDocuments(urls)
    onDocs(documents)
    return null
  }

  it.only("returns a collection of documents, given a list of ids", async () => {
    const { documentUrls, wrapper } = setup()
    const onDocs = vi.fn()

    render(
      <Suspense fallback={<div>Loaidng</div>}>
        <Component urls={documentUrls} onDocs={onDocs} />
      </Suspense>,
      { wrapper }
    )
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((id, i) => [id, { foo: i }]))
      )
    )
  })

  it("returns a collection of loaded documents immediately, given a list of ids", async () => {
    const { documentUrls, wrapper } = setup()
    const onDocs = vi.fn()

    render(<Component urls={documentUrls} onDocs={onDocs} />, { wrapper })

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
        <Component urls={documentUrls} onDocs={onDocs} />,
        { wrapper }
      )
      await waitFor(() => unmount())
    }

    for (const id of documentUrls) {
      const handle = await repo.find(id)

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

    render(<Component urls={documentUrls} onDocs={onDocs} />, { wrapper })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((id, i) => [id, { foo: i }]))
      )
    )

    React.act(() => {
      // multiply the value of foo in each document by 10
      documentUrls.forEach(async id => {
        const handle = await repo.find(id)
        handle.change((s: any) => (s.foo *= 10))
      })
    })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((id, i) => [id, { foo: i * 10 }]))
      )
    )
  })

  it("updates documents when they change, if URLs are passed in", async () => {
    const { repo, documentUrls, wrapper } = setup()
    const onDocs = vi.fn()

    render(<Component urls={documentUrls} onDocs={onDocs} />, { wrapper })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((id, i) => [id, { foo: i }]))
      )
    )

    React.act(() => {
      // multiply the value of foo in each document by 10
      documentUrls.forEach(async id => {
        const handle = await repo.find(id)
        handle.change((s: any) => (s.foo *= 10))
      })
    })
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((id, i) => [id, { foo: i * 10 }]))
      )
    )
  })

  it(`removes documents when they're removed from the list of ids`, async () => {
    const { documentUrls, wrapper } = setup()
    const onDocs = vi.fn()

    const { rerender } = render(
      <Component urls={documentUrls} onDocs={onDocs} />,
      { wrapper }
    )
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((id, i) => [id, { foo: i }]))
      )
    )

    // remove the first document
    rerender(<Component urls={documentUrls.slice(1)} onDocs={onDocs} />)
    // 👆 Note that this only works because documentUrls.slice(1) is a different
    // object from documentUrls. If we modified documentUrls directly, the hook
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
      <Component urls={documentUrls} onDocs={onDocs} />,
      { wrapper }
    )
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(documentUrls.map((id, i) => [id, { foo: i }]))
      )
    )

    // remove the first document
    React.act(() => {
      rerender(<Component urls={documentUrls.slice(1)} onDocs={onDocs} />)
    })
    // 👆 Note that this only works because documentUrls.slice(1) is a different
    // object from documentUrls. If we modified documentUrls directly, the hook
    // wouldn't re-run.
    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(
          documentUrls.map((id, i) => [id, { foo: i }]).slice(1)
        )
      )
    )

    // update all the docs that are still in the list

    React.act(() => {
      // multiply the value of foo in each document by 10
      documentUrls.slice(1).forEach(async id => {
        const handle = await repo.find(id)
        handle.change((s: any) => (s.foo *= 10))
      })
    })

    await waitFor(() =>
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(
          documentUrls.map((id, i) => [id, { foo: i * 10 }]).slice(1)
        )
      )
    )

    React.act(() => {
      // multiply the value of foo in each document by 10
      documentUrls.slice(1).forEach(async id => {
        const handle = await repo.find(id)
        handle.change((s: any) => (s.foo *= 10))
      })
    })

    await waitFor(() => {
      expect(onDocs).toHaveBeenCalledWith(
        Object.fromEntries(
          documentUrls.map((id, i) => [id, { foo: i * 100 }]).slice(1)
        )
      )
    })
  })
})

const range = (n: number) => [...Array(n).keys()]
