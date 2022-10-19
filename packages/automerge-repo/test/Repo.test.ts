import { Repo } from "../src/Repo"
import { DummyNetworkAdapter } from "./helpers/DummyNetworkAdapter"
import { MemoryStorageAdapter } from "automerge-repo-storage-memory"
import assert from "assert"

export interface TestDoc {
  foo: string
}

describe("Repo", () => {
  const repo = new Repo({
    storage: new MemoryStorageAdapter(),
    network: [new DummyNetworkAdapter()],
  })

  it("can instantiate a Repo", () => {
    assert(repo !== null)
  })

  it("has a network subsystem", () => {
    assert(repo.networkSubsystem)
  })

  it("has a storage subsystem", () => {
    assert(repo.storageSubsystem)
  })

  it("can create a document", () => {
    const handle = repo.create()
    assert(handle.documentId != null)
  })

  it("can find a created document", (done) => {
    const handle = repo.create<TestDoc>()
    handle.change((d) => {
      d.foo = "bar"
    })
    assert(handle.state === "ready")
    const handle2 = repo.find<TestDoc>(handle.documentId)
    assert(handle === handle2)
    assert(handle2.ready())
    handle2.value().then((v) => {
      done()
      assert(v.foo === "bar")
    })
  })
})
