import React, { type PropsWithChildren } from "react"
import { Repo, type DocumentProgress } from "@automerge/automerge-repo"
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

export const pause = (ms = 0) =>
  new Promise<void>(resolve => setTimeout(resolve, ms))

// Mock the lookup boundary, not the removed network protocol.
export function setupDelayedRepo(latency = 10) {
  const repoCreator = new Repo()
  const repoFinder = new Repo()
  repos.add(repoCreator)
  repos.add(repoFinder)
  const localProgress = repoFinder.findWithProgress.bind(repoFinder)
  const localFind = repoFinder.find.bind(repoFinder)
  const loaded = new Set<string>()

  vi.spyOn(repoFinder, "findWithProgress").mockImplementation(id => {
    const local = localProgress(id)
    if (local.peek().state === "ready") return local
    const progress = repoCreator.findWithProgress(id)
    return {
      ...progress,
      peek: () =>
        loaded.has(String(id))
          ? progress.peek()
          : { state: "loading", sources: { mock: "pending" } },
    } as DocumentProgress<unknown>
  })
  vi.spyOn(repoFinder, "find").mockImplementation(async (id, options) => {
    const local = localProgress(id)
    if (local.peek().state === "ready") return localFind(id, options)
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
