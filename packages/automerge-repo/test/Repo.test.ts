import * as Automerge from "@automerge/automerge"
import { Repo } from "../src/Repo"
import { DocHandle } from "../src/DocHandle"
import { DummyNetworkAdapter } from "./helpers/DummyNetworkAdapter"
import { MemoryStorageAdapter } from "../src/storage/interfaces/MemoryStorageAdapter"
import { CollectionSynchronizer } from "../src/synchronizer/CollectionSynchronizer"

describe("CollectionSynchronizer", () => {
  it("TODO", async () => {
    const handle = new DocHandle("synced-doc")
    handle.replace(Automerge.init())
    const repo = await Repo({
      storage: new MemoryStorageAdapter(),
      network: [new DummyNetworkAdapter()],
    })
    const synchronizer = new CollectionSynchronizer(repo)
  })
})
