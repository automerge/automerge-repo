import assert from "assert"
import { describe, it } from "vitest"
import { next as Automerge } from "@automerge/automerge"
import {
  encodeHeads,
  generateAutomergeUrl,
  parseAutomergeUrl,
} from "../src/AutomergeUrl.js"
import { DocHandle } from "../src/DocHandle.js"
import { DocumentQuery } from "../src/DocumentQuery.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { MessageContents } from "../src/network/messages.js"
import { DocSynchronizer } from "../src/synchronizer/DocSynchronizer.js"
import type { ShareConfig } from "../src/synchronizer/DocSynchronizer.js"
import { PeerId } from "../src/types.js"
import { TestDoc } from "./types.js"

const alice = "alice" as PeerId
const bob = "bob" as PeerId
const charlie = "charlie" as PeerId

/** Network is already ready for all unit tests. */
const networkReady = Promise.resolve()

/** Default share config: announce to everyone, grant all access. */
const defaultShareConfig: ShareConfig = {
  announce: async () => true,
  access: async () => true,
}

/** Create a DocSynchronizer with its required query and networkReady. */
function createDocSynchronizer(
  handle: DocHandle<unknown>,
  query?: DocumentQuery<unknown>,
  shareConfig?: ShareConfig
): DocSynchronizer {
  if (!query) {
    query = new DocumentQuery(handle.documentId)
    // Point the query's internal handle at the one we were given by
    // feeding it the same initial doc (if any).
    const doc = handle.doc()
    if (Automerge.getHeads(doc).length > 0) {
      query.handle.update(() => doc)
    }
  }
  return new DocSynchronizer({
    handle,
    query,
    networkReady,
    shareConfig: shareConfig ?? defaultShareConfig,
  })
}

describe("DocSynchronizer", () => {
  let handle: DocHandle<TestDoc>
  let docSynchronizer: DocSynchronizer

  const setup = () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId
    handle = new DocHandle<TestDoc>(docId)
    // Give the handle some initial data so it has heads
    handle.update(() => Automerge.from<TestDoc>({ foo: "" }))

    docSynchronizer = createDocSynchronizer(handle as DocHandle<unknown>)

    return { handle, docSynchronizer }
  }

  it("takes the handle passed into it", () => {
    const { handle, docSynchronizer } = setup()
    assert(docSynchronizer.documentId === handle.documentId)
  })

  it("emits a syncMessage when addPeer is called", async () => {
    const { docSynchronizer } = setup()
    // Register listener before addPeer — messages are emitted synchronously
    const p = eventPromise(docSynchronizer, "message")
    docSynchronizer.addPeer(alice, Promise.resolve(undefined))
    const { targetId, type } = await p
    assert.equal(type, "sync")
    assert.equal(targetId, "alice")
  })

  it("emits a syncMessage to peers when the handle is updated", async () => {
    const { handle, docSynchronizer } = setup()
    docSynchronizer.addPeer(alice, Promise.resolve(undefined)) // emits initial message synchronously
    // Register listener after addPeer but before the change
    const p = eventPromise(docSynchronizer, "message")
    handle.change(doc => {
      doc.foo = "bar"
    })
    const { targetId, type } = await p
    assert.equal(targetId, "alice")
    assert.equal(type, "sync")
  })

  it("emits a syncState message when the sync state is updated", async () => {
    const { handle, docSynchronizer } = setup()

    // Collect sync-state events
    const syncStates: any[] = []
    docSynchronizer.on("sync-state", s => syncStates.push(s))

    docSynchronizer.addPeer(alice, Promise.resolve(undefined))
    handle.change(doc => {
      doc.foo = "bar"
    })

    // Wait for at least 3 events: 2 from addPeer (initial state + sendSyncMessage)
    // plus 1 from the throttled change handler
    await new Promise<void>(resolve => {
      const check = () => {
        if (syncStates.length >= 3) resolve()
        else setTimeout(check, 10)
      }
      check()
    })

    // All events should be for alice + this document
    assert(syncStates.every(s => s.peerId === "alice"))
    assert(syncStates.every(s => s.documentId === handle.documentId))

    // The last sync-state should reflect the current heads
    const lastState = syncStates[syncStates.length - 1]
    assert.deepStrictEqual(
      encodeHeads(lastState.syncState.lastSentHeads),
      handle.heads()
    )
  })

  it("still syncs with a peer after it disconnects and reconnects", async () => {
    const { handle, docSynchronizer } = setup()

    // first connection
    {
      const p = eventPromise(docSynchronizer, "message")
      docSynchronizer.addPeer(bob, Promise.resolve(undefined))
      handle.change(doc => {
        doc.foo = "a change"
      })
      const { targetId, type } = await p
      assert.equal(targetId, "bob")
      assert.equal(type, "sync")
      docSynchronizer.removePeer(bob)
    }

    // second connection
    {
      const p = eventPromise(docSynchronizer, "message")
      docSynchronizer.addPeer(bob, Promise.resolve(undefined))
      handle.change(doc => {
        doc.foo = "another change"
      })
      const { targetId, type } = await p
      assert.equal(targetId, "bob")
      assert.equal(type, "sync")
    }
  })

  it("emits a requestMessage when the local handle has no data", async () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId

    // Empty handle — no data loaded
    const handle = new DocHandle<TestDoc>(docId)
    docSynchronizer = createDocSynchronizer(handle as DocHandle<unknown>)
    const p = eventPromise(docSynchronizer, "message")
    docSynchronizer.addPeer(alice, Promise.resolve(undefined))
    const message = await p
    assert.equal(message.targetId, "alice")
    assert.equal(message.type, "request")
  })

  it("sends request to unknown peers and sync (not request) to known peers", async () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId

    // Bob has no data — his first message will be a request
    const bobHandle = new DocHandle<TestDoc>(docId)
    const bobDocSynchronizer = createDocSynchronizer(
      bobHandle as DocHandle<unknown>
    )
    const bobP = eventPromise(bobDocSynchronizer, "message")
    bobDocSynchronizer.addPeer(alice, Promise.resolve(undefined))
    const bobMsg = await bobP

    // Alice also has no data
    const aliceHandle = new DocHandle<TestDoc>(docId)
    const aliceDocSynchronizer = createDocSynchronizer(
      aliceHandle as DocHandle<unknown>
    )

    // Collect all messages from alice
    const messages: MessageContents[] = []
    aliceDocSynchronizer.on("message", m => messages.push(m))

    // Add bob — alice sends an initial request (both have no data)
    aliceDocSynchronizer.addPeer(bob, Promise.resolve(undefined))
    // Wait for peer activation (Promise.all needs 2+ microtask ticks)
    await new Promise(r => setTimeout(r, 0))

    // Receive bob's message — alice now knows bob wants the doc
    aliceDocSynchronizer.receiveMessage({ ...bobMsg, senderId: bob })

    // Add charlie (unknown peer) — should get a request
    aliceDocSynchronizer.addPeer(charlie, Promise.resolve(undefined))
    await new Promise(r => setTimeout(r, 0))

    const charlieMessage = messages.find(m => m.targetId === charlie)
    const bobMessages = messages.filter(m => m.targetId === bob)

    // Charlie gets a request (alice doesn't know if charlie has the doc)
    assert.ok(charlieMessage, "should have a message for charlie")
    assert.equal(charlieMessage!.type, "request")

    // Bob's initial message from addPeer is a "request" (unknown peer, no data).
    // Any subsequent messages to bob after receiving his request should NOT be
    // "request" (because bob is now known). They should be "sync" or absent.
    const bobNonInitialMsgs = bobMessages.slice(1)
    for (const msg of bobNonInitialMsgs) {
      assert.notEqual(
        msg.type,
        "request",
        "subsequent messages to bob should not be requests"
      )
    }
  })

  it("emits peer-status events when peer statuses change", async () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId
    const handle = new DocHandle<TestDoc>(docId)
    const docSync = createDocSynchronizer(handle as DocHandle<unknown>)

    const statuses: { peerId: PeerId; status: string }[] = []
    docSync.on("peer-status", s => statuses.push(s))

    // Add a peer — no peer-status for "unknown" (it's the initial state)
    docSync.addPeer(alice, Promise.resolve(undefined))

    // Receive a doc-unavailable from alice
    docSync.receiveMessage({
      type: "doc-unavailable",
      senderId: alice,
      targetId: bob,
      documentId: docId,
    })

    assert.equal(statuses.length, 1)
    assert.equal(statuses[0].peerId, "alice")
    assert.equal(statuses[0].status, "unavailable")
  })

  it("sends doc-unavailable to wanting peers when sync is exhausted", async () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId

    // Create a query so DocSynchronizer can evaluate unavailability.
    // Mark both sources as unavailable so the query reaches "unavailable".
    const query = new DocumentQuery<TestDoc>(docId)
    query.sourcePending("storage")
    query.sourcePending("automerge-sync")
    query.sourceUnavailable("storage")

    const docSync = new DocSynchronizer({
      handle: query.handle as DocHandle<unknown>,
      query: query as DocumentQuery<unknown>,
      networkReady,
      shareConfig: defaultShareConfig,
    })

    // Create bob's side to generate a request message
    const bobHandle = new DocHandle<TestDoc>(docId)
    const bobDocSync = createDocSynchronizer(bobHandle as DocHandle<unknown>)
    const bobP = eventPromise(bobDocSync, "message")
    bobDocSync.addPeer(alice, Promise.resolve(undefined))
    const reqMsg = await bobP

    // Collect all messages from our DocSynchronizer
    const messages: MessageContents[] = []
    docSync.on("message", m => messages.push(m))

    // Add bob and feed him the request — this marks bob as "wants",
    // which triggers checkSyncExhausted. Since all peers are exhausted
    // (bob is "wants") and the query is unavailable (storage gave up),
    // DocSynchronizer sends doc-unavailable to bob.
    docSync.addPeer(bob, Promise.resolve(undefined))
    // Wait for peer activation (Promise.all needs 2+ microtask ticks)
    await new Promise(r => setTimeout(r, 0))
    docSync.receiveMessage({ ...reqMsg, senderId: bob })

    // Wait for #evaluate to process the message and send doc-unavailable
    await new Promise(r => setTimeout(r, 0))

    const unavailableMsg = messages.find(m => m.type === "doc-unavailable")
    assert.ok(unavailableMsg, "should have sent doc-unavailable")
    assert.equal(unavailableMsg!.targetId, bob)
  })
})
