import assert from "assert"
import { DocumentId, PeerId } from "../src/types"
import { DocHandle } from "../src/DocHandle"
import { DocSynchronizer } from "../src/synchronizer/DocSynchronizer"
import { eventPromise } from "../src/helpers/eventPromise"

type TestDoc = {
  foo: string
}

const alice = "alice" as PeerId
const bob = "bob" as PeerId

describe("DocSynchronizer", () => {
  let handle: DocHandle<TestDoc>
  let docSynchronizer: DocSynchronizer

  const setup = () => {
    handle = new DocHandle<{ foo: string }>("synced-doc" as DocumentId, true)
    docSynchronizer = new DocSynchronizer(handle)
    return { handle, docSynchronizer }
  }

  it("takes the handle passed into it", () => {
    const { handle, docSynchronizer } = setup()
    assert(docSynchronizer.documentId === handle.documentId)
  })

  it("emits a syncMessage when beginSync is called", async () => {
    const { docSynchronizer } = setup()
    docSynchronizer.beginSync(alice)
    const { targetId } = await eventPromise(docSynchronizer, "message")
    assert.equal(targetId, "alice")
  })

  it("emits a syncMessage to peers when the handle is updated", async () => {
    const { handle, docSynchronizer } = setup()
    docSynchronizer.beginSync(alice)
    handle.change(doc => {
      doc.foo = "bar"
    })
    const { targetId } = await eventPromise(docSynchronizer, "message")
    assert.equal(targetId, "alice")
  })

  it("still syncs with a peer after it disconnects and reconnects", async () => {
    const { handle, docSynchronizer } = setup()

    // first connection
    {
      await docSynchronizer.beginSync(bob)
      handle.change(doc => {
        doc.foo = "a change"
      })
      const { targetId } = await eventPromise(docSynchronizer, "message")
      assert.equal(targetId, "bob")
      docSynchronizer.endSync(bob)
    }

    // second connection
    {
      await docSynchronizer.beginSync(bob)
      handle.change(doc => {
        doc.foo = "another change"
      })
      const { targetId } = await eventPromise(docSynchronizer, "message")
      assert.equal(targetId, "bob")
    }
  })
})
