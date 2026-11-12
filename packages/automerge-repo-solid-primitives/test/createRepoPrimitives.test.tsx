import { Repo } from "@automerge/automerge-repo"
import { render, waitFor } from "@solidjs/testing-library"
import { createEffect } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RepoContext } from "../src/context.js"
import { createRepoPrimitives } from "../src/createRepoPrimitives.js"
import usePackageRepo from "../src/useRepo.js"

describe("createRepoPrimitives", () => {
  const repos: Repo[] = []
  afterEach(async () => {
    document.body.innerHTML = ""
    await Promise.all(repos.splice(0).map(repo => repo.shutdown()))
  })
  function repo() {
    const r = new Repo()
    repos.push(r)
    return r
  }

  it("gives its primitives the provided Repo, and the package's too", async () => {
    const a = repo()
    const { RepoProvider, useRepo, useDocHandle, useDocument, useDocSignal } =
      createRepoPrimitives(a)
    const handle = await a.create({ count: 1 })
    const seen = vi.fn()
    const Component = () => {
      const typed = useDocHandle<{ count: number }>(handle.url)
      const [doc, documentHandle] = useDocument<{ count: number }>(handle.url)
      const [signal] = useDocSignal<{ count: number }>(handle.url)
      const repos = { repo: useRepo(), packageRepo: usePackageRepo() }
      createEffect(() =>
        seen({
          ...repos,
          typed: typed(),
          documentHandle: documentHandle(),
          count: doc()?.count,
          signal: signal()?.count,
        })
      )
      return null
    }
    render(() => (
      <RepoProvider value={a}>
        <Component />
      </RepoProvider>
    ))
    await waitFor(() =>
      expect(seen).toHaveBeenLastCalledWith({
        repo: a,
        packageRepo: a,
        typed: handle,
        documentHandle: handle,
        count: 1,
        signal: 1,
      })
    )
  })

  it("takes any Repo of its type, e.g. one per test", () => {
    const { RepoProvider, useRepo } = createRepoPrimitives<Repo>()
    const [a, b] = [repo(), repo()]
    const seen = vi.fn()
    const Component = () => {
      seen(useRepo())
      return null
    }
    render(() => (
      <>
        <RepoProvider value={a}>
          <Component />
        </RepoProvider>
        <RepoProvider value={b}>
          <Component />
        </RepoProvider>
      </>
    ))
    expect(seen.mock.calls.map(([r]) => r)).toEqual([a, b])
  })

  it("throws without its provider, even inside the package's", () => {
    const r = repo()
    const { useRepo } = createRepoPrimitives(r)
    const Component = () => {
      useRepo()
      return null
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(() => <Component />)).toThrow(
      /Repo was not found on its RepoProvider/
    )
    expect(() =>
      render(() => (
        <RepoContext.Provider value={r}>
          <Component />
        </RepoContext.Provider>
      ))
    ).toThrow(/Repo was not found on its RepoProvider/)
    spy.mockRestore()
  })
})
