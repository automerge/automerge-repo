import { PeerId, Repo } from "@automerge/automerge-repo"
import React from "react"
import { describe, it } from "vitest"
import { RepoContext } from "../src/useRepo"
import { DummyStorageAdapter } from "@automerge/automerge-repo/test/helpers/DummyStorageAdapter"

describe("useDocuments", () => {
  it("works", async () => {
    const repo = new Repo({
      peerId: "alice" as PeerId,
      network: [],
      storage: new DummyStorageAdapter(),
    })
    const documentIds = []
    for (let i = 0; i < 10; i++) {
      const doc = repo.create<ExampleDoc>({
        foo: Math.round(Math.random() * 100),
      })
      documentIds.push(doc.id)
    }
  })
})

function getRepoWrapper(repo: Repo) {
  return ({ children }) => (
    <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>
  )
}

interface ExampleDoc {
  foo: number
}
