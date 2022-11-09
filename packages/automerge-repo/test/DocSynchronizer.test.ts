import assert from "assert"
import { DocHandle, DocumentId } from "../src/DocHandle"
import { DocSynchronizer } from "../src/synchronizer/DocSynchronizer"
import { PeerId } from "../src/network/NetworkSubsystem"

describe("DocSynchronizer", () => {
  const handle = new DocHandle("synced-doc" as DocumentId, true)
  const docSynchronizer = new DocSynchronizer(handle)

  it("should take the handle passed into it", () => {
    assert(docSynchronizer.handle === handle)
  })

  it("should emit a syncMessage when beginSync is called", (done) => {
    docSynchronizer.on("message", () => done())
    docSynchronizer.beginSync("imaginary-peer-id" as PeerId)
  })
})
