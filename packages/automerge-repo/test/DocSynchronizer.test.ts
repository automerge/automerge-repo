import assert from "assert"
import { describe, it, vi } from "vitest"
import { next as Automerge } from "@automerge/automerge"
import {
  encodeHeads,
  generateAutomergeUrl,
  parseAutomergeUrl,
} from "../src/AutomergeUrl.js"
import { DocHandle } from "../src/DocHandle.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { pause } from "../src/helpers/pause.js"
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

  it("asyncThrottle on the 'change' handler serializes #syncWithPeers (never re-entered while in flight)", async () => {
    vi.useFakeTimers()
    try {
      const { handle, docSynchronizer } = setup()

      // asyncThrottle is configured with docSynchronizer.syncDebounceRate as
      // its delay. The advances below are tuned relative to that, not arbitrary:
      //  - CHANGE_INTERVAL_MS < THROTTLE_MS so multiple changes coalesce into
      //    one throttle window.
      //  - SLOW_WHEN_READY_MS > CHANGE_INTERVAL_MS so each #syncWithPeers run
      //    spans multiple change firings — without serialization this would
      //    expose re-entry.
      //  - DRAIN_MS is generous enough for all throttled and queued work to
      //    settle before we assert.
      const THROTTLE_MS = docSynchronizer.syncDebounceRate
      const CHANGE_INTERVAL_MS = THROTTLE_MS * 0.3
      const SLOW_WHEN_READY_MS = THROTTLE_MS * 0.8
      const DRAIN_MS = THROTTLE_MS * 6

      docSynchronizer.beginSync([alice])
      // Wait for the initial beginSync message so any whenReady calls inside
      // beginSync have settled before we install the measurement patch.
      // beginSync's whenReady chain is microtask-driven (handle is doneLoading),
      // so the message emits without needing the clock to advance.
      await eventPromise(docSynchronizer, "message")

      // #syncWithPeers starts with `await this.#handle.whenReady()`. By patching
      // whenReady on this specific handle to be slow, we make each run of
      // #syncWithPeers take measurable time. asyncThrottle wraps the 'change'
      // handler's `() => this.#syncWithPeers()`, so if it correctly awaits the
      // prior run before scheduling the next, whenReady must never be concurrent.
      const origWhenReady = handle.whenReady.bind(handle)
      let concurrent = 0
      let maxConcurrent = 0
      let whenReadyCalls = 0
      handle.whenReady = async (...args: Parameters<typeof origWhenReady>) => {
        concurrent++
        whenReadyCalls++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        try {
          await origWhenReady(...args)
          await pause(SLOW_WHEN_READY_MS)
        } finally {
          concurrent--
        }
      }

      // Fire rapid changes spaced so later ones land while a prior run is still
      // in #syncWithPeers (waiting on the slow whenReady).
      for (let i = 0; i < 6; i++) {
        handle.change(doc => {
          doc.foo = `v${i}`
        })
        await vi.advanceTimersByTimeAsync(CHANGE_INTERVAL_MS)
      }
      await vi.advanceTimersByTimeAsync(DRAIN_MS)

      assert(
        whenReadyCalls > 0,
        `expected #syncWithPeers to call whenReady, got ${whenReadyCalls}`
      )
      assert.equal(maxConcurrent, 1)
    } finally {
      vi.useRealTimers()
    }
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
