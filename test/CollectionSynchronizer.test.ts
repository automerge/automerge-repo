import * as Automerge from "automerge-js"
import Repo from "../src/Repo"
import DummyNetworkAdapter from "./helpers/DummyNetworkAdapter"
import DocHandle from "../src/DocHandle"
import MemoryStorageAdapter from "../src/storage/interfaces/MemoryStorageAdapter"
import CollectionSynchronizer from "../src/synchronizer/CollectionSynchronizer"

describe("CollectionSynchronizer", async () => {
  const handle = new DocHandle("synced-doc")
  handle.replace(Automerge.init())
  const repo = await Repo({
    storage: new MemoryStorageAdapter(),
    network: [new DummyNetworkAdapter()],
  })
  const synchronizer = new CollectionSynchronizer(repo)

  it("should probably do something")
})
