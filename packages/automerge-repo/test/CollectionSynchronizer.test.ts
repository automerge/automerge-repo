import * as Automerge from "@automerge/automerge"
import { Repo } from "../src/Repo"
import { DummyNetworkAdapter } from "./helpers/DummyNetworkAdapter"
import { DocHandle } from "../src/DocHandle"
import { MemoryStorageAdapter } from "automerge-repo-storage-memory"
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
