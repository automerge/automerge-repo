import { Repo } from "@automerge/automerge-repo"
import { render, waitFor } from "@testing-library/react"
import React, { Suspense } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRepoHooks } from "../src/createRepoHooks.js"
import { useDocument } from "../src/useDocument.js"
import { RepoContext, useRepo as usePackageRepo } from "../src/useRepo.js"
import { wrapperCache } from "../src/useDocHandle.js"

describe("createRepoHooks", () => {
  const repos: Repo[] = []
  afterEach(async () => {
    wrapperCache.clear()
    await Promise.all(repos.splice(0).map(repo => repo.shutdown()))
  })
  function repo() {
    const r = new Repo()
    repos.push(r)
    return r
  }

  it("gives its hooks the provided Repo, and the package's hooks too", async () => {
    const a = repo()
    const { RepoProvider, useRepo, useDocHandle, useDocHandles } =
      createRepoHooks(a)
    const handle = await a.create({ count: 1 })
    const seen = vi.fn()
    const Component = () => {
      const typed = useDocHandle<{ count: number }>(handle.url, {
        suspense: true,
      })
      const many = useDocHandles<{ count: number }>([handle.url])
      const [doc] = useDocument<{ count: number }>(handle.url)
      seen({ repo: useRepo(), packageRepo: usePackageRepo(), typed, many, doc })
      return null
    }
    render(
      <RepoProvider value={a}>
        <Suspense fallback={null}>
          <Component />
        </Suspense>
      </RepoProvider>
    )
    await waitFor(() =>
      expect(seen).toHaveBeenLastCalledWith({
        repo: a,
        packageRepo: a,
        typed: handle,
        many: new Map([[handle.url, handle]]),
        doc: { count: 1 },
      })
    )
  })

  it("takes any Repo of its type, e.g. one per test", () => {
    const { RepoProvider, useRepo } = createRepoHooks<Repo>()
    const [a, b] = [repo(), repo()]
    const seen = vi.fn()
    const Component = () => {
      seen(useRepo())
      return null
    }
    render(
      <>
        <RepoProvider value={a}>
          <Component />
        </RepoProvider>
        <RepoProvider value={b}>
          <Component />
        </RepoProvider>
      </>
    )
    expect(seen.mock.calls.map(([r]) => r)).toEqual([a, b])
  })

  it("throws without its provider, even inside the package's", () => {
    const r = repo()
    const { useRepo } = createRepoHooks(r)
    const Component = () => {
      useRepo()
      return null
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Component />)).toThrow(
      /Repo was not found on its RepoProvider/
    )
    expect(() =>
      render(
        <RepoContext.Provider value={r}>
          <Component />
        </RepoContext.Provider>
      )
    ).toThrow(/Repo was not found on its RepoProvider/)
    spy.mockRestore()
  })
})
