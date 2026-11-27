import { automerge, Repo } from "@automerge/automerge-repo"
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import React, { Suspense, type PropsWithChildren } from "react"
import { afterEach, describe, expect, it } from "vitest"
import "@testing-library/jest-dom"

import { createRepoHooks } from "../src/createRepoHooks"
import { cacheKey, normalizeId } from "../src/handleCache"
import { useDocHandle } from "../src/useDocHandle"
import { useDocHandles } from "../src/useDocHandles"
import { useDocument } from "../src/useDocument"
import { useDocuments } from "../src/useDocuments"
import { RepoContext } from "../src/useRepo"
import { CounterHandle, counter } from "./counter"
import type { ExampleDoc } from "./testSetup"

const repos: Repo[] = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map(repo => repo.shutdown()))
})

async function setup() {
  const repo = new Repo()
  repos.push(repo)
  const handle = await repo.create(0, { docType: counter })
  const wrapper = ({ children }: PropsWithChildren) => (
    <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>
  )
  return { repo, handle, wrapper }
}

describe("doc types", () => {
  it("useDocHandle opens a document of the given doc type", async () => {
    const { handle, wrapper } = await setup()
    const { result } = renderHook(
      () => useDocHandle(handle.url, { docType: counter }),
      { wrapper }
    )
    expect(result.current).toBe(handle)
    expect(result.current).toBeInstanceOf(CounterHandle)
  })

  it("useDocHandle opens a bare document ID as the given doc type", async () => {
    const { handle, wrapper } = await setup()
    const { result } = renderHook(
      () => useDocHandle(handle.documentId, { docType: counter }),
      { wrapper }
    )
    expect(result.current).toBe(handle)
  })

  it("useDocHandle suspends until a document of the doc type is found", async () => {
    const { repo, handle, wrapper } = await setup()
    await repo.removeFromCache(handle.documentId)
    const Component = () => {
      const found = useDocHandle(handle.url, {
        suspense: true,
        docType: counter,
      })
      return <div data-testid="value">{found.doc()}</div>
    }
    render(
      <Suspense fallback={<div data-testid="loading" />}>
        <Component />
      </Suspense>,
      { wrapper }
    )
    await waitFor(() =>
      expect(screen.getByTestId("value")).toHaveTextContent("0")
    )
  })

  it("useDocument gives a falsy value, and changes it with the handle's change", async () => {
    const { handle, wrapper } = await setup()
    const { result } = renderHook(
      () => useDocument(handle.url, { docType: counter }),
      { wrapper }
    )
    expect(result.current[0]).toBe(0)
    await act(() => result.current[1](2))
    expect(result.current[0]).toBe(2)
    await act(() => handle.increment(3))
    expect(result.current[0]).toBe(5)
  })

  it("useDocument with automerge.of<T>() is useDocument<T>", async () => {
    const { repo, wrapper } = await setup()
    const doc = await repo.create<ExampleDoc>({ foo: "A" })
    const { result } = renderHook(
      () => useDocument(doc.url, { docType: automerge.of<ExampleDoc>() }),
      { wrapper }
    )
    expect(result.current[0]).toEqual({ foo: "A" })
    await act(() => result.current[1](d => void (d.foo = "B")))
    expect(result.current[0]).toEqual({ foo: "B" })
  })

  it("useDocHandles and useDocuments open documents of the given doc type", async () => {
    const { repo, handle, wrapper } = await setup()
    const other = await repo.create(4, { docType: counter })
    const urls = [handle.url, other.url]
    const handles = renderHook(
      () => useDocHandles(urls, { docType: counter }),
      { wrapper }
    )
    await waitFor(() =>
      expect([...handles.result.current.values()]).toEqual([handle, other])
    )
    const docs = renderHook(() => useDocuments(urls, { docType: counter }), {
      wrapper,
    })
    await waitFor(() =>
      expect([...docs.result.current[0].values()]).toEqual([0, 4])
    )
    await act(() => docs.result.current[1](other.url, 1))
    expect(docs.result.current[0].get(other.url)).toBe(5)
  })

  it("keys lookups by doc type", async () => {
    const { handle } = await setup()
    expect(normalizeId(handle.url)).toBe(handle.url)
    expect(cacheKey(handle.documentId, counter)).toBe(handle.url)
    expect(cacheKey(handle.url, counter)).toBe(handle.url)
    expect(cacheKey(handle.documentId)).not.toBe(handle.url)
    expect(cacheKey(handle.url)).not.toBe(handle.url)
  })

  it("createRepoHooks passes the doc type on", async () => {
    const { repo, handle } = await setup()
    const hooks = createRepoHooks(repo)
    const wrapper = ({ children }: PropsWithChildren) => (
      <hooks.RepoProvider value={repo}>{children}</hooks.RepoProvider>
    )
    const { result } = renderHook(
      () => ({
        handle: hooks.useDocHandle(handle.url, { docType: counter }),
        doc: hooks.useDocument(handle.url, { docType: counter })[0],
      }),
      { wrapper }
    )
    expect(result.current.handle).toBe(handle)
    expect(result.current.doc).toBe(0)
  })
})
