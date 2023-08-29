import assert from "assert"
import { DocCollection, BinaryDocumentId } from "../src/index.js"
import { TestDoc } from "./types.js"
import { generateAutomergeUrl, stringifyAutomergeUrl } from "../src/DocUrl.js"

const MISSING_DOCID = generateAutomergeUrl()

describe("DocCollection", () => {
  it("can create documents which are ready to go", async () => {
    const collection = new DocCollection()
    const handle = collection.create<TestDoc>()
    assert(handle.isReady() === true)
  })

  it("can start finding documents and they shouldn't be ready", () => {
    const collection = new DocCollection()
    const handle = collection.find<TestDoc>(MISSING_DOCID)
    assert(handle.isReady() === false)
  })
})
