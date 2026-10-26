import React, { type PropsWithChildren } from "react"
import {
  Repo,
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocumentQuery,
  type QueryState,
} from "@automerge/automerge-repo"
import "@testing-library/jest-dom"
import { cleanup } from "@testing-library/react"
import { afterEach, vi } from "vitest"
import { RepoContext } from "../src/useRepo"
import { wrapperCache } from "../src/useDocHandle"

const repos = new Set<Repo>()

afterEach(async () => {
  cleanup()
  wrapperCache.clear()
  vi.restoreAllMocks()
  await Promise.all(Array.from(repos, repo => repo.shutdown()))
  repos.clear()
})

export interface ExampleDoc {
  foo: string
  counter?: number
  nested?: { value: string }
}

/** A legacy 16-byte document URL; Repo opens it under its 32-byte form. */
export const legacyUrl =
  "automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu" as AutomergeUrl

/** A delayed document reachable through {@link legacyUrl}. */
export async function setupLegacy(latency = 100) {
  const { repoCreator, repoFinder: repo, wrapper } = setupDelayedRepo(latency)
  const source = await repoCreator.create<ExampleDoc>({ foo: "Legacy" })
  const handle = await repoCreator.import<ExampleDoc>(
    (await repoCreator.export(source.url))!,
    { docId: parseAutomergeUrl(legacyUrl).documentId }
  )
  return { repo, handle, wrapper }
}

export const pause = (ms = 0) =>
  new Promise<void>(resolve => setTimeout(resolve, ms))

// Mock the lookup boundary, not the removed network protocol.
export function setupDelayedRepo(latency = 10) {
  const repoCreator = new Repo()
  const repoFinder = new Repo()
  repos.add(repoCreator)
  repos.add(repoFinder)
  const localQuery = repoFinder.query.bind(repoFinder)
  const localFind = repoFinder.find.bind(repoFinder)
  const loaded = new Set<string>()

  vi.spyOn(repoFinder, "query").mockImplementation(id => {
    const local = localQuery(id)
    if (local.state().state === "ready") return local
    const query = repoCreator.query(id)
    // Hide the creator's state until the delayed find has "loaded" it.
    const hide = (state: QueryState<unknown>): QueryState<unknown> =>
      loaded.has(String(id)) ? state : { state: "loading" }
    return {
      documentId: query.documentId,
      state: () => hide(query.state()),
      subscribe: callback => query.subscribe(state => callback(hide(state))),
    } as DocumentQuery<unknown>
  })
  vi.spyOn(repoFinder, "find").mockImplementation(async (id, options) => {
    const local = localQuery(id)
    if (local.state().state === "ready") return localFind(id, options)
    await pause(latency)
    options?.signal?.throwIfAborted()
    const handle = await repoCreator.find(id, options)
    loaded.add(String(id))
    return handle
  })

  const wrapper = ({ children }: PropsWithChildren) => (
    <RepoContext.Provider value={repoFinder}>{children}</RepoContext.Provider>
  )
  return { repoCreator, repoFinder, wrapper }
}

export async function setup(latency = 100) {
  const { repoCreator, repoFinder: repo, wrapper } = setupDelayedRepo(latency)
  const [handleA, handleB, handleC] = await Promise.all(
    ["A", "B", "C"].map(foo => repo.create<ExampleDoc>({ foo }))
  )
  const [handleD, handleE] = await Promise.all(
    ["D", "E"].map(foo => repoCreator.create<ExampleDoc>({ foo }))
  )
  return {
    repo,
    handleA,
    handleB,
    handleC,
    delayedDocUrlD: handleD.url,
    delayedDocUrlE: handleE.url,
    handles: [handleA, handleB, handleC],
    urls: [handleA.url, handleB.url, handleC.url],
    wrapper,
  }
}
