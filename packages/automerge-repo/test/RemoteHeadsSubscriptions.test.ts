import * as A from "@automerge/automerge"
import assert from "assert"
import { describe, it } from "vitest"
import { RemoteHeadsSubscriptions } from "../src/RemoteHeadsSubscriptions.js"
import { PeerId, StorageId } from "../src/index.js"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { pause } from "../src/helpers/pause.js"
import { EventEmitter } from "eventemitter3"
import {
  RemoteHeadsChanged,
  RemoteSubscriptionControlMessage,
} from "../src/network/messages.js"

describe("RepoHeadsSubscriptions", () => {
  const storageA = "remote-a" as StorageId
  const storageB = "remote-b" as StorageId
  const peerA = "peer-a" as PeerId
  const peerB = "peer-b" as PeerId
  const peerC = "peer-c" as PeerId
  const peerD = "peer-d" as PeerId

  const { documentId: docA } = parseAutomergeUrl(generateAutomergeUrl())
  const { documentId: docB } = parseAutomergeUrl(generateAutomergeUrl())
  const { documentId: docC } = parseAutomergeUrl(generateAutomergeUrl())

  const docAHeadsChangedForStorageB: RemoteHeadsChanged = {
    type: "remote-heads-changed",
    senderId: peerD,
    targetId: peerA,
    documentId: docA,
    newHeads: {
      [storageB]: {
        heads: [],
        timestamp: Date.now(),
      },
    },
  }

  const docBHeadsChangedForStorageB: RemoteHeadsChanged = {
    type: "remote-heads-changed",
    senderId: peerD,
    targetId: peerA,
    documentId: docB,
    newHeads: {
      [storageB]: {
        heads: [],
        timestamp: Date.now(),
      },
    },
  }

  const docBHeads = A.getHeads(
    A.change(A.init(), doc => {
      ;(doc as any).foo = "123"
    })
  )

  const docBHeadsChangedForStorageB2: RemoteHeadsChanged = {
    type: "remote-heads-changed",
    senderId: peerD,
    targetId: peerA,
    documentId: docB,
    newHeads: {
      [storageB]: {
        heads: docBHeads,
        timestamp: Date.now() + 1,
      },
    },
  }

  const subscribePeerCToStorageB: RemoteSubscriptionControlMessage = {
    type: "remote-subscription-change",
    senderId: peerC,
    targetId: peerA,
    add: [storageB],
  }

  const unsubscribePeerCFromStorageB: RemoteSubscriptionControlMessage = {
    type: "remote-subscription-change",
    senderId: peerC,
    targetId: peerA,
    remove: [storageB],
  }

  it("should allow to subscribe and unsubscribe to storage ids", async () => {
    const remoteHeadsSubscription = new RemoteHeadsSubscriptions()

    const remoteHeadsMessages = waitForMessages(
      remoteHeadsSubscription,
      "remote-heads-changed"
    )

    const changeRemoteSubsAfterSubscribe = waitForMessages(
      remoteHeadsSubscription,
      "change-remote-subs"
    )

    // subscribe to storageB and change storageB heads
    remoteHeadsSubscription.subscribeToRemotes([storageB])
    remoteHeadsSubscription.handleRemoteHeads(docAHeadsChangedForStorageB)

    // receive event for new heads of storageB
    let messages = await remoteHeadsMessages
    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].storageId, storageB)
    assert.strictEqual(messages[0].documentId, docA)
    assert.deepStrictEqual(messages[0].remoteHeads, [])

    // receive event for add sub to storageB
    messages = await changeRemoteSubsAfterSubscribe
    assert.strictEqual(messages.length, 1)
    assert.deepStrictEqual(messages[0].add, [storageB])
    assert.deepStrictEqual(messages[0].remove, undefined)
    assert.deepStrictEqual(messages[0].peers, [])

    const remoteHeadsMessagesAfterUnsub = waitForMessages(
      remoteHeadsSubscription,
      "change-remote-subs"
    )

    // unsubscribe from storageB
    remoteHeadsSubscription.unsubscribeFromRemotes([storageB])

    // receive event for remove sub from storageB
    messages = await remoteHeadsMessagesAfterUnsub
    assert.strictEqual(messages.length, 1)
    assert.deepStrictEqual(messages[0].add, undefined)
    assert.deepStrictEqual(messages[0].remove, [storageB])
    assert.deepStrictEqual(messages[0].peers, [])
  })

  it("should forward all changes to generous peers", async () => {
    const remoteHeadsSubscription = new RemoteHeadsSubscriptions()

    const notifyRemoteHeadsMessagesPromise = waitForMessages(
      remoteHeadsSubscription,
      "notify-remote-heads"
    )

    const changeRemoteSubsMessagesPromise = waitForMessages(
      remoteHeadsSubscription,
      "change-remote-subs"
    )

    remoteHeadsSubscription.addGenerousPeer(peerC)
    remoteHeadsSubscription.subscribeToRemotes([storageB])

    // change message for docA in storageB
    remoteHeadsSubscription.handleRemoteHeads(docAHeadsChangedForStorageB)

    // change heads directly, are not forwarded
    remoteHeadsSubscription.handleImmediateRemoteHeadsChanged(
      docC,
      storageB,
      []
    )

    // should forward remote-heads events
    let messages = await notifyRemoteHeadsMessagesPromise
    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].documentId, docA)
    assert.strictEqual(messages[0].storageId, storageB)
    assert.deepStrictEqual(messages[0].heads, [])

    // should forward subscriptions to generous peer
    messages = await changeRemoteSubsMessagesPromise
    assert.strictEqual(messages.length, 1)
    assert.deepStrictEqual(messages[0].add, [storageB])
    assert.deepStrictEqual(messages[0].remove, undefined)
    assert.deepStrictEqual(messages[0].peers, [peerC])

    const changeRemoteSubsMessagesAfterUnsubPromise = waitForMessages(
      remoteHeadsSubscription,
      "change-remote-subs"
    )

    // unsubsscribe from storage B
    remoteHeadsSubscription.unsubscribeFromRemotes([storageB])

    // should forward unsubscribe to generous peer
    messages = await changeRemoteSubsMessagesAfterUnsubPromise
    assert.strictEqual(messages.length, 1)
    assert.deepStrictEqual(messages[0].add, undefined)
    assert.deepStrictEqual(messages[0].remove, [storageB])
    assert.deepStrictEqual(messages[0].peers, [peerC])
  })

  it("should not notify generous peers of changed remote heads, if they send the heads originally", async () => {
    const remoteHeadsSubscription = new RemoteHeadsSubscriptions()

    const messagesPromise = waitForMessages(
      remoteHeadsSubscription,
      "notify-remote-heads"
    )

    remoteHeadsSubscription.addGenerousPeer(peerC)
    remoteHeadsSubscription.subscribeToRemotes([storageB])
    remoteHeadsSubscription.handleRemoteHeads({
      type: "remote-heads-changed",
      senderId: peerC,
      targetId: peerA,
      documentId: docA,
      newHeads: {
        [storageB]: {
          heads: [],
          timestamp: Date.now(),
        },
      },
    })

    const messages = await messagesPromise
    assert.strictEqual(messages.length, 0)
  })

  it("should allow peers to subscribe and unsubscribe to storageIds", async () => {
    const remoteHeadsSubscription = new RemoteHeadsSubscriptions()
    remoteHeadsSubscription.subscribeToRemotes([storageB])

    // subscribe peer c to storage b
    remoteHeadsSubscription.handleControlMessage(subscribePeerCToStorageB)
    const messagesAfterSubscribePromise = waitForMessages(
      remoteHeadsSubscription,
      "notify-remote-heads"
    )

    // change message for docA in storageB
    remoteHeadsSubscription.handleRemoteHeads(docAHeadsChangedForStorageB)

    // change heads directly
    remoteHeadsSubscription.handleImmediateRemoteHeadsChanged(
      docC,
      storageB,
      []
    )

    // expect peer c to be notified both changes
    let messages = await messagesAfterSubscribePromise
    assert.strictEqual(messages.length, 2)
    assert.strictEqual(messages[0].documentId, docA)
    assert.strictEqual(messages[0].storageId, storageB)
    assert.deepStrictEqual(messages[0].heads, [])
    assert.strictEqual(messages[1].documentId, docC)
    assert.strictEqual(messages[1].storageId, storageB)
    assert.deepStrictEqual(messages[1].heads, [])

    // unsubscribe peer C
    remoteHeadsSubscription.handleControlMessage(unsubscribePeerCFromStorageB)
    const messagesAfteUnsubscribePromise = waitForMessages(
      remoteHeadsSubscription,
      "notify-remote-heads"
    )

    // heads of docB for storageB change
    remoteHeadsSubscription.handleRemoteHeads(docBHeadsChangedForStorageB)

    // expect not to be be notified
    messages = await messagesAfteUnsubscribePromise
    assert.strictEqual(messages.length, 0)
  })

  it("should ignore sync states with an older timestamp", async () => {
    const remoteHeadsSubscription = new RemoteHeadsSubscriptions()

    const messagesPromise = waitForMessages(
      remoteHeadsSubscription,
      "remote-heads-changed"
    )

    remoteHeadsSubscription.subscribeToRemotes([storageB])
    remoteHeadsSubscription.handleRemoteHeads(docBHeadsChangedForStorageB2)

    // send message with old heads
    remoteHeadsSubscription.handleRemoteHeads(docBHeadsChangedForStorageB)

    const messages = await messagesPromise
    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].storageId, storageB)
    assert.strictEqual(messages[0].documentId, docB)
    assert.deepStrictEqual(messages[0].remoteHeads, docBHeads)
  })
})

async function waitForMessages(
  emitter: EventEmitter,
  event: string,
  timeout: number = 100
): Promise<any[]> {
  const messages = []

  const onEvent = message => {
    messages.push(message)
  }

  emitter.on(event, onEvent)

  await pause(timeout)

  emitter.off(event)

  return messages
}
