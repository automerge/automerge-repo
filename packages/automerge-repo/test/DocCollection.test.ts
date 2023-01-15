import { assert } from "console"
import { DocCollection } from "../src/DocCollection"
import { DocumentId } from "../src/types"

interface TestDoc {
  foo: string
}

const MISSING_DOCID = "non-existent-docID" as DocumentId

describe("DocCollection", () => {
  it("can create documents which are ready to go", async () => {
    const collection = new DocCollection()
    const handle = collection.create<TestDoc>()
    assert(handle.ready() === true)
  })

  it("can start finding documents and they shouldn't be ready", () => {
    const collection = new DocCollection()
    const handle = collection.find<TestDoc>(MISSING_DOCID)
    assert(handle.ready() === false)
  })
})
