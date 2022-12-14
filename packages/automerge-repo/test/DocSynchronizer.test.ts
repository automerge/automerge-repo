import assert from "assert"
import { DocHandle, DocumentId } from "../src/DocHandle"
import { DocSynchronizer } from "../src/synchronizer/DocSynchronizer"
import { PeerId } from "../src/network/NetworkSubsystem"

describe("DocSynchronizer", () => {
  let handle: DocHandle<{foo: string}>
  let docSynchronizer: DocSynchronizer

  beforeEach(() => {
    handle = new DocHandle<{foo: string}>("synced-doc" as DocumentId, true)
    docSynchronizer = new DocSynchronizer(handle)
  })

  it("should take the handle passed into it", () => {
    assert(docSynchronizer.handle === handle)
  })

  it("should emit a syncMessage when beginSync is called", (done) => {
    docSynchronizer.once("message", () => done())
    docSynchronizer.beginSync("imaginary-peer-id" as PeerId)
  })

  it("should emit a syncMessage to peers when the handle is updated", (done) => {
    docSynchronizer.beginSync("imaginary-peer-id" as PeerId)
    docSynchronizer.once("message", () => done())
    handle.change((doc) => {
      doc.foo = "bar"
    })
  })

  it("should emit a syncMessage to peers when the peer is removed, then re-added", (done) => {
    docSynchronizer.beginSync("imaginary-peer-id-2" as PeerId).then(() => {
      handle.change((doc) => {
        doc.foo = "bar"
      })
      docSynchronizer.endSync("imaginary-peer-id-2" as PeerId)
      docSynchronizer.beginSync("imaginary-peer-id-2" as PeerId).then(
        () => {
          docSynchronizer.once("message", (event) => {
            if (event.targetId === "imaginary-peer-id-2") {
              done()
            }
          })
          handle.change((doc) => {
            doc.foo = "baz"
          })
        }
      )
    })
  })
})
