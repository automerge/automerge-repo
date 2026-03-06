import assert from "assert"
import { describe, it, vi } from "vitest"
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
import { createTestHandle, createTestQuery } from "./helpers/refConstructor.js"

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
    query = new DocumentQuery(handle)
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
    handle = createTestHandle<TestDoc>(docId)
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

  it("debounces change-triggered sync using the public peer API", async () => {
    vi.useFakeTimers()
    try {
      const { handle, docSynchronizer } = setup()

      const initialMessage = eventPromise(docSynchronizer, "message")
      docSynchronizer.addPeer(alice, Promise.resolve(undefined))
      await initialMessage

      const messages: MessageContents[] = []
      docSynchronizer.on("message", m => messages.push(m))

      const THROTTLE_MS = docSynchronizer.syncDebounceRate
      for (let i = 0; i < 6; i++) {
        handle.change(doc => {
          doc.foo = `v${i}`
        })
        await vi.advanceTimersByTimeAsync(THROTTLE_MS * 0.3)
      }

      await vi.advanceTimersByTimeAsync(THROTTLE_MS * 3)

      assert(
        messages.some(m => m.type === "sync" && m.targetId === alice),
        "expected a debounced sync message after local changes"
      )
    } finally {
      vi.useRealTimers()
    }
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
    const handle = createTestHandle<TestDoc>(docId)
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
    const bobHandle = createTestHandle<TestDoc>(docId)
    const bobDocSynchronizer = createDocSynchronizer(
      bobHandle as DocHandle<unknown>
    )
    const bobP = eventPromise(bobDocSynchronizer, "message")
    bobDocSynchronizer.addPeer(alice, Promise.resolve(undefined))
    const bobMsg = await bobP

    // Alice also has no data
    const aliceHandle = createTestHandle<TestDoc>(docId)
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
    const handle = createTestHandle<TestDoc>(docId)
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

  it("addPeer twice for the same peer: stale activation no-ops", async () => {
    const { docSynchronizer } = setup()

    let resolveFirst: (s: Automerge.SyncState | undefined) => void = () => {}
    const firstSyncState = new Promise<Automerge.SyncState | undefined>(res => {
      resolveFirst = res
    })

    docSynchronizer.addPeer(alice, firstSyncState)

    // Second addPeer: resets the peer state. The first activation is now stale.
    docSynchronizer.addPeer(alice, Promise.resolve(undefined))

    // Wait for the second activation to complete.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    // Capture sync-state events before resolving the stale promise.
    const syncStatesBefore: any[] = []
    docSynchronizer.on("sync-state", s => syncStatesBefore.push(s))

    // Resolve the first activation. Should be silently discarded — no
    // sync-state event for the stale activation.
    resolveFirst(undefined)
    await new Promise(r => setTimeout(r, 0))

    assert.equal(
      syncStatesBefore.length,
      0,
      "stale activation should not emit sync-state"
    )
  })

  it("waits for all suppliers' heads before responding to wanting peer", async () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId

    // Empty handle on alice's side. Two peers will advertise different
    // heads via sync messages; until alice has both, she shouldn't tell
    // any wanting peer that the doc is unavailable.
    const aliceHandle = createTestHandle<TestDoc>(docId)
    const aliceQuery = new DocumentQuery(aliceHandle)
    aliceQuery.sourcePending("automerge-sync")
    aliceQuery.sourceUnavailable("storage")
    const aliceSync = new DocSynchronizer({
      handle: aliceHandle as DocHandle<unknown>,
      query: aliceQuery as DocumentQuery<unknown>,
      networkReady,
      shareConfig: defaultShareConfig,
    })

    // Two supplier peers with distinct histories.
    const bobHandle = createTestHandle<TestDoc>(docId)
    bobHandle.update(() => Automerge.from<TestDoc>({ foo: "bob" }))
    const charlieHandle = createTestHandle<TestDoc>(docId)
    charlieHandle.update(() => Automerge.from<TestDoc>({ foo: "charlie" }))

    // Alice gets sync messages from both bob and charlie advertising "has".
    const bobSync = createDocSynchronizer(bobHandle as DocHandle<unknown>)
    const bobMsgP = eventPromise(bobSync, "message")
    bobSync.addPeer(alice, Promise.resolve(undefined))
    const bobMsg = await bobMsgP

    const charlieSync = createDocSynchronizer(
      charlieHandle as DocHandle<unknown>
    )
    const charlieMsgP = eventPromise(charlieSync, "message")
    charlieSync.addPeer(alice, Promise.resolve(undefined))
    const charlieMsg = await charlieMsgP

    // Add a wanting peer (drew) and feed alice the request.
    const drewHandle = createTestHandle<TestDoc>(docId)
    const drewSync = createDocSynchronizer(drewHandle as DocHandle<unknown>)
    const drewReqP = eventPromise(drewSync, "message")
    drewSync.addPeer(alice, Promise.resolve(undefined))
    const drewReq = await drewReqP

    const aliceMessages: MessageContents[] = []
    aliceSync.on("message", m => aliceMessages.push(m))

    aliceSync.addPeer(bob, Promise.resolve(undefined))
    aliceSync.addPeer(charlie, Promise.resolve(undefined))
    aliceSync.addPeer("drew" as PeerId, Promise.resolve(undefined))
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    aliceSync.receiveMessage({ ...bobMsg, senderId: bob })
    aliceSync.receiveMessage({ ...drewReq, senderId: "drew" as PeerId })
    await new Promise(r => setTimeout(r, 0))

    // At this point alice has heard from bob (a supplier) but hasn't received
    // bob's data yet, and hasn't heard from charlie. She must NOT have told
    // drew the document is unavailable.
    const earlyUnavailable = aliceMessages.find(
      m => m.type === "doc-unavailable" && m.targetId === "drew"
    )
    assert.equal(
      earlyUnavailable,
      undefined,
      "should not declare unavailable while suppliers still owe data"
    )

    // Now charlie advertises too — still no unavailable.
    aliceSync.receiveMessage({ ...charlieMsg, senderId: charlie })
    await new Promise(r => setTimeout(r, 0))
    const stillEarly = aliceMessages.find(
      m => m.type === "doc-unavailable" && m.targetId === "drew"
    )
    assert.equal(
      stillEarly,
      undefined,
      "should not declare unavailable while neither supplier has delivered"
    )
  })

  it("denied peer's queued sync messages get doc-unavailable", async () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId
    const handle = createTestHandle<TestDoc>(docId)
    handle.update(() => Automerge.from<TestDoc>({ foo: "secret" }))

    const denied: ShareConfig = {
      announce: async () => false,
      access: async () => false,
    }
    const docSync = createDocSynchronizer(
      handle as DocHandle<unknown>,
      undefined,
      denied
    )

    // Generate a sync message from a peer.
    const otherHandle = createTestHandle<TestDoc>(docId)
    otherHandle.update(() => Automerge.from<TestDoc>({ foo: "other" }))
    const otherSync = createDocSynchronizer(otherHandle as DocHandle<unknown>)
    const otherP = eventPromise(otherSync, "message")
    otherSync.addPeer(alice, Promise.resolve(undefined))
    const syncMsg = await otherP

    const messages: MessageContents[] = []
    docSync.on("message", m => messages.push(m))

    // Bob arrives with a queued sync message. Activation will see denied
    // and should respond doc-unavailable for the sync (not silently drop).
    docSync.addPeer(bob, Promise.resolve(undefined), {
      messages: [{ ...syncMsg, senderId: bob } as any],
    })
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const unavailable = messages.find(
      m => m.type === "doc-unavailable" && m.targetId === bob
    )
    assert.ok(
      unavailable,
      "denied peer's queued sync should get doc-unavailable"
    )
  })

  it("denied peer is re-engaged when share policy flips to allow", async () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId
    const handle = createTestHandle<TestDoc>(docId)
    handle.update(() => Automerge.from<TestDoc>({ foo: "secret" }))

    let allowAccess = false
    const dynamic: ShareConfig = {
      announce: async () => false,
      access: async () => allowAccess,
    }
    const docSync = createDocSynchronizer(
      handle as DocHandle<unknown>,
      undefined,
      dynamic
    )

    // Bob's side generates a sync message.
    const bobHandle = createTestHandle<TestDoc>(docId)
    bobHandle.update(() => Automerge.from<TestDoc>({ foo: "bob" }))
    const bobSync = createDocSynchronizer(bobHandle as DocHandle<unknown>)
    const bobP = eventPromise(bobSync, "message")
    bobSync.addPeer(alice, Promise.resolve(undefined))
    const bobMsg = await bobP

    const messages: MessageContents[] = []
    docSync.on("message", m => messages.push(m))

    // Bob arrives while denied — gets doc-unavailable for the queued sync.
    docSync.addPeer(bob, Promise.resolve(undefined), {
      messages: [{ ...bobMsg, senderId: bob } as any],
    })
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    assert.ok(
      messages.find(m => m.type === "doc-unavailable" && m.targetId === bob),
      "should have sent doc-unavailable while denied"
    )

    // Flip access on, then re-evaluate. Bob should be re-engaged with sync.
    allowAccess = true
    docSync.reevaluateSharePolicy()
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const syncToBob = messages.find(
      m => m.type === "sync" && m.targetId === bob
    )
    assert.ok(syncToBob, "should send sync to peer after policy flips to allow")
  })

  it("ephemeral message received twice in a mesh only emits once", async () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId
    const handle = createTestHandle<TestDoc>(docId)
    handle.update(() => Automerge.from<TestDoc>({ foo: "" }))
    const docSync = createDocSynchronizer(handle as DocHandle<unknown>)

    docSync.addPeer(alice, Promise.resolve(undefined))
    docSync.addPeer(bob, Promise.resolve(undefined))
    await new Promise(r => setTimeout(r, 0))

    const received: any[] = []
    handle.on("ephemeral-message", payload => received.push(payload))

    const ephemeral = {
      type: "ephemeral" as const,
      senderId: charlie,
      targetId: alice,
      documentId: docId,
      sessionId: "session-1",
      count: 1,
      data: new Uint8Array([
        0xa1, 0x63, 0x66, 0x6f, 0x6f, 0x63, 0x62, 0x61, 0x72,
      ]), // cbor: { foo: "bar" }
    }

    // First arrival from alice (carrying charlie's message)
    docSync.receiveMessage({ ...ephemeral, senderId: alice })
    // Second arrival from bob (same charlie ephemeral, mesh duplicate)
    docSync.receiveMessage({ ...ephemeral, senderId: alice })
    await new Promise(r => setTimeout(r, 0))

    assert.equal(received.length, 1, "should only emit ephemeral-message once")
  })

  it("sends doc-unavailable to wanting peers when sync is exhausted", async () => {
    const docId = parseAutomergeUrl(generateAutomergeUrl()).documentId

    // Create a query so DocSynchronizer can evaluate unavailability.
    // Mark both sources as unavailable so the query reaches "unavailable".
    const query = createTestQuery<TestDoc>(docId)
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
    const bobHandle = createTestHandle<TestDoc>(docId)
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
