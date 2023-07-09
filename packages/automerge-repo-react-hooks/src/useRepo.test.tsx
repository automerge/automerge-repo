// @ts-nocheck
/// <reference types="vitest" />
import { describe, expect, test, vi } from "vitest"
import { act, renderHook, render } from "@testing-library/react"
import { RepoContext, useRepo } from "./useRepo"
import { Repo } from "@automerge/automerge-repo"

describe("useRepo", () => {
  const repo = new Repo({
    network: [],
  })
  expect(repo).toBeInstanceOf(Repo)

  test("should error when context unavailable", () => {
    // Prevent console spam by swallowing console.error "uncaught error" message
    const spy = vi.spyOn(console, "error")
    spy.mockImplementation(() => {})

    expect(() => renderHook(() => useRepo())).toThrow(
      /Repo was not found on RepoContext/
    )

    spy.mockRestore()
  })

  test.skip("should return repo from context", () => {
    const wrapper = ({ children }) => (
      <RepoContext value={repo} children={children} />
    )
    const { result } = renderHook(() => useRepo(), { wrapper })
    expect(result).toBeInstanceOf(Repo)
  })
})
