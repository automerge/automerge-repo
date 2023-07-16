// @ts-nocheck
/// <reference types="vitest" />
import { act, renderHook, render } from "@testing-library/react"
import { RepoContext, useRepo } from "./useRepo"
import { Repo } from "@automerge/automerge-repo"

describe("useRepo", () => {
  const repo = new Repo({
    network: [],
  })
  
  expect(repo).toBeInstanceOf(Repo)
  // TODO: @pvh: Move this test to automerge-repo
  test.skip("should `new Repo({ network: [] })` work")

  test("should error when context unavailable", () => {
    // Prevent console spam by swallowing console.error "uncaught error" message
    const spy = vi.spyOn(console, "error")
    spy.mockImplementation(() => {})

    expect(() => renderHook(() => useRepo())).toThrow(
      /Repo was not found on RepoContext/
    )

    spy.mockRestore()
  })

  test("should return repo from context", () => {
    const wrapper = ({ children }) => (
      <RepoContext.Provider value={repo} children={children} />
    )
    const { result } = renderHook(() => useRepo(), { wrapper })
    expect(result.current).toBeInstanceOf(Repo)
  })
})
