import { CollectionSynchronizer } from "../src/synchronizer/CollectionSynchronizer"
import assert from "assert"
import { DocCollection } from "../src/DocCollection"

describe("CollectionSynchronizer", () => {
  const collection = new DocCollection()
  const synchronizer = new CollectionSynchronizer(collection)

  it("is not null", async () => {
    assert(synchronizer !== null)
  })
})
