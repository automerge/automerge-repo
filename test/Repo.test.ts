import assert from "assert"
import { StorageSubsystem } from "../src"
import Repo from "../src/Repo"
import MemoryStorageAdapter from "../src/storage/interfaces/MemoryStorageAdapter"

describe("Repo", () => {
  it("should assign a UUID on create()", () => {
    const memoryStorage = new StorageSubsystem(new MemoryStorageAdapter())
    const repo = new Repo(memoryStorage)
    const handle = repo.create()
    assert(handle.documentId)
  })
})
