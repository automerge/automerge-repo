import { Repo } from "@automerge/automerge-repo"
import { render } from "@testing-library/react"
import React from "react"
import { describe, expect, test, vi } from "vitest"
import { RepoContext, useRepo } from "../src/useRepo.js"

describe("useRepo", () => {
  const Component = ({ onRepo }: { onRepo: (repo: Repo) => void }) => {
    const repo = useRepo()
    onRepo(repo)
    return null
  }

  test("should error when context unavailable", () => {
    // Prevent console spam by swallowing console.error "uncaught error" message
    const spy = vi.spyOn(console, "error")
    spy.mockImplementation(() => {})
    expect(() => render(<Component onRepo={() => {}} />)).toThrow(
      /Repo was not found on RepoContext/
    )
    spy.mockRestore()
  })

  test("should return repo from context", () => {
    const repo = new Repo()
    const wrapper = ({ children }) => (
      <RepoContext.Provider value={repo} children={children} />
    )
    const onRepo = vi.fn()
    render(<Component onRepo={onRepo} />, { wrapper })
    expect(onRepo).toHaveBeenLastCalledWith(repo)
  })
})
