import assert from "assert"
import { describe, it } from "vitest"
import { next as Automerge } from "@automerge/automerge"
import {
  encodeHeads,
  generateAutomergeUrl,
  parseAutomergeUrl,
} from "../src/AutomergeUrl.js"
import { DocHandle } from "../src/DocHandle.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import {
  DocumentUnavailableMessage,
  MessageContents,
} from "../src/network/messages.js"
import { DocSynchronizer } from "../src/synchronizer/DocSynchronizer.js"
import { PeerId } from "../src/types.js"
import { TestDoc } from "./types.js"

const alice = "alice" as PeerId
const bob = "bob" as PeerId
const charlie = "charlie" as PeerId

describe("DocSynchronizer", () => {
  let handle: DocHandle<TestDoc>
  let docSynchronizer: DocSynchronizer

  const setup = () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId
    handle = new DocHandle<TestDoc>(docId)
    handle.doneLoading()

    docSynchronizer = new DocSynchronizer({
      handle: handle as DocHandle<unknown>,
    })

    return { handle, docSynchronizer }
  }

  it("takes the handle passed into it", () => {
    const { handle, docSynchronizer } = setup()
    assert(docSynchronizer.documentId === handle.documentId)
  })

  it("emits a syncMessage when beginSync is called", async () => {
    const { docSynchronizer } = setup()
    docSynchronizer.beginSync([alice])
    const { targetId, type } = await eventPromise(docSynchronizer, "message")
    assert.equal(type, "sync")
    assert.equal(targetId, "alice")
  })

  it("emits a syncMessage to peers when the handle is updated", async () => {
    const { handle, docSynchronizer } = setup()
    docSynchronizer.beginSync([alice])
    handle.change(doc => {
      doc.foo = "bar"
    })
    const { targetId, type } = await eventPromise(docSynchronizer, "message")
    assert.equal(targetId, "alice")
    assert.equal(type, "sync")
  })

  it("emits a syncState message when the sync state is updated", async () => {
    const { handle, docSynchronizer } = setup()
    docSynchronizer.beginSync([alice])
    handle.change(doc => {
      doc.foo = "bar"
    })
    const message1 = await eventPromise(docSynchronizer, "sync-state")
    const message2 = await eventPromise(docSynchronizer, "sync-state")

    assert.equal(message1.peerId, "alice")
    assert.equal(message1.documentId, handle.documentId)
    assert.deepStrictEqual(message1.syncState.lastSentHeads, [])

    assert.equal(message2.peerId, "alice")
    assert.equal(message2.documentId, handle.documentId)
    assert.deepStrictEqual(
      encodeHeads(message2.syncState.lastSentHeads),
      handle.heads()
    )
  })

  it("still syncs with a peer after it disconnects and reconnects", async () => {
    const { handle, docSynchronizer } = setup()

    // first connection
    {
      docSynchronizer.beginSync([bob])
      handle.change(doc => {
        doc.foo = "a change"
      })
      const { targetId, type } = await eventPromise(docSynchronizer, "message")
      assert.equal(targetId, "bob")
      assert.equal(type, "sync")
      docSynchronizer.endSync(bob)
    }

    // second connection
    {
      docSynchronizer.beginSync([bob])
      handle.change(doc => {
        doc.foo = "another change"
      })
      const { targetId, type } = await eventPromise(docSynchronizer, "message")
      assert.equal(targetId, "bob")
      assert.equal(type, "sync")
    }
  })

  it("emits a requestMessage if the local handle is being requested", async () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId

    const handle = new DocHandle<TestDoc>(docId, { isNew: false })
    docSynchronizer = new DocSynchronizer({
      handle: handle as DocHandle<unknown>,
    })
    docSynchronizer.beginSync([alice])
    handle.request()
    const message = await eventPromise(docSynchronizer, "message")
    assert.equal(message.targetId, "alice")
    assert.equal(message.type, "request")
  })

  it("emits the correct sequence of messages when a document is not found then not available", async () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId

    const bobHandle = new DocHandle<TestDoc>(docId, { isNew: false })
    const bobDocSynchronizer = new DocSynchronizer({
      handle: bobHandle as DocHandle<unknown>,
    })
    bobDocSynchronizer.beginSync([alice])
    bobHandle.request()
    const message = await eventPromise(bobDocSynchronizer, "message")

    const aliceHandle = new DocHandle<TestDoc>(docId, { isNew: false })
    const aliceDocSynchronizer = new DocSynchronizer({
      handle: aliceHandle as DocHandle<unknown>,
    })
    aliceHandle.request()

    aliceDocSynchronizer.receiveSyncMessage({ ...message, senderId: bob })
    aliceDocSynchronizer.beginSync([charlie, bob])

    const messages = await new Promise<MessageContents[]>(resolve => {
      const messages: MessageContents[] = []
      aliceDocSynchronizer.on("message", message => {
        messages.push(message)
        if (messages.length === 2) {
          resolve(messages)
        }
      })
    })

    const bobMessage = messages.find(m => m.targetId === bob)
    const charlieMessage = messages.find(m => m.targetId === charlie)

    // the response should be a sync message, not a request message
    assert.equal(charlieMessage.targetId, "charlie")
    assert.equal(charlieMessage.type, "request")
    assert.equal(bobMessage.targetId, "bob")
    assert.equal(bobMessage.type, "sync")

    const docUnavailableMessage = {
      type: "doc-unavailable",
      targetId: alice,
      senderId: charlie,
      documentId: docId,
    } satisfies DocumentUnavailableMessage

    const p = eventPromise(aliceDocSynchronizer, "message")

    aliceDocSynchronizer.receiveMessage(docUnavailableMessage)

    const message2 = await p

    assert.equal(message2.targetId, "bob")
    assert.equal(message2.type, "doc-unavailable")
  })
})
