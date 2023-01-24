import { CollectionSynchronizer } from "../src/synchronizer/CollectionSynchronizer.js"
import assert from "assert"
import { DocCollection } from "../src/DocCollection.js"

describe("CollectionSynchronizer", () => {
  const collection = new DocCollection()
  const synchronizer = new CollectionSynchronizer(collection)

  it("is not null", async () => {
    assert(synchronizer !== null)
  })
})
