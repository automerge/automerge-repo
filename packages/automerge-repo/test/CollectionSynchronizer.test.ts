import { CollectionSynchronizer } from "../src/synchronizer/CollectionSynchronizer"
import { DocCollection } from "../src"
import assert from "assert"

describe("CollectionSynchronizer", () => {
  const collection = new DocCollection()
  const synchronizer = new CollectionSynchronizer(collection)

  it("is not null", async () => {
    assert(synchronizer !== null)
  })
})
