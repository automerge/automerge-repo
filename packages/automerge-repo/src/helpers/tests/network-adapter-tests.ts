import assert from "assert"
import { describe, expect, it } from "vitest"
import {
  generateAutomergeUrl,
  parseAutomergeUrl,
  PeerId,
  PeerMetadata,
  Repo,
  StorageId,
} from "../../index.js"
import type { NetworkAdapterInterface } from "../../network/NetworkAdapterInterface.js"
import { eventPromise, eventPromises } from "../eventPromise.js"
import { pause } from "../pause.js"

/**
 * Runs a series of tests against a set of three peers, each represented by one or more instantiated
 * network adapters.
 *
 * The adapter `setup` function should return an object with the following properties:
 *
 * - `adapters`: A tuple representing three peers' network configuration. Each element can be either
 *   a single adapter or an array of adapters. Each will be used to instantiate a Repo for that
 *   peer.
 * - `teardown`: An optional function that will be called after the tests have run. This can be used
 *   to clean up any resources that were created during the test.
 */
export function runNetworkAdapterTests(_setup: SetupFn, title?: string): void {
  // Wrap the provided setup function
  const setup = async () => {
    const { adapters, teardown = NO_OP } = await _setup()

    // these might be individual adapters or arrays of adapters; normalize them to arrays
    const [a, b, c] = adapters.map(toArray)

    return { adapters: [a, b, c], teardown }
  }

  describe(`Network adapter acceptance tests ${
    title ? `(${title})` : ""
  }`, () => {
    it("can sync 2 repos", async () => {
      const doTest = async (
        a: NetworkAdapterInterface[],
        b: NetworkAdapterInterface[]
      ) => {
        const aliceRepo = new Repo({ network: a, peerId: alice })
        const bobRepo = new Repo({ network: b, peerId: bob })

        // Alice creates a document
        const aliceHandle = aliceRepo.create<TestDoc>()

        // Bob receives the document
        await eventPromise(bobRepo, "document")
        const bobHandle = await bobRepo.find<TestDoc>(aliceHandle.url)

        // Alice changes the document
        aliceHandle.change(d => {
          d.foo = "bar"
        })

        // Bob receives the change
        await eventPromise(bobHandle, "change")
        assert.equal(bobHandle.doc().foo, "bar")

        // Bob changes the document
        bobHandle.change(d => {
          d.foo = "baz"
        })

        // Alice receives the change
        await eventPromise(aliceHandle, "change")
        assert.equal(aliceHandle.doc().foo, "baz")
      }

      // Run the test in both directions, in case they're different types of adapters
      {
        const { adapters, teardown } = await setup()
        const [x, y] = adapters
        await doTest(x, y) // x is Alice
        teardown()
      }
      {
        const { adapters, teardown } = await setup()
        const [x, y] = adapters
        await doTest(y, x) // y is Alice
        teardown()
      }
    })

    it("can sync 3 repos", async () => {
      const { adapters, teardown } = await setup()
      const [a, b, c] = adapters

      const aliceRepo = new Repo({ network: a, peerId: alice })
      const bobRepo = new Repo({ network: b, peerId: bob })
      const charlieRepo = new Repo({ network: c, peerId: charlie })

      // Alice creates a document
      const aliceHandle = aliceRepo.create<TestDoc>()
      const docUrl = aliceHandle.url

      // Bob and Charlie receive the document
      await eventPromises([bobRepo, charlieRepo], "document")
      const bobHandle = await bobRepo.find<TestDoc>(docUrl)
      const charlieHandle = await charlieRepo.find<TestDoc>(docUrl)

      // Alice changes the document
      aliceHandle.change(d => {
        d.foo = "bar"
      })

      // Bob and Charlie receive the change
      await eventPromises([bobHandle, charlieHandle], "change")
      assert.equal(bobHandle.doc().foo, "bar")
      assert.equal(charlieHandle.doc().foo, "bar")

      // Charlie changes the document
      charlieHandle.change(d => {
        d.foo = "baz"
      })

      // Alice and Bob receive the change
      await eventPromises([aliceHandle, bobHandle], "change")
      assert.equal(bobHandle.doc().foo, "baz")
      assert.equal(charlieHandle.doc().foo, "baz")

      teardown()
    })

    it("can broadcast a message", async () => {
      const { adapters, teardown } = await setup()
      const [a, b, c] = adapters

      const aliceRepo = new Repo({ network: a, peerId: alice })
      const bobRepo = new Repo({ network: b, peerId: bob })
      const charlieRepo = new Repo({ network: c, peerId: charlie })

      await eventPromises(
        [aliceRepo, bobRepo, charlieRepo].map(r => r.networkSubsystem),
        "peer"
      )

      const aliceHandle = aliceRepo.create<TestDoc>()
      const charlieHandle = await charlieRepo.find(aliceHandle.url)

      // pause to give charlie a chance to let alice know it wants the doc
      await pause(100)

      const alicePresenceData = { presence: "alice" }
      aliceHandle.broadcast(alicePresenceData)

      const { message } = await eventPromise(charlieHandle, "ephemeral-message")

      assert.deepStrictEqual(message, alicePresenceData)
      teardown()
    })

    it("emits a peer-candidate event with proper peer metadata when a peer connects", async () => {
      const { adapters, teardown } = await setup()
      const a = adapters[0][0]
      const b = adapters[1][0]

      const bPromise = eventPromise(b, "peer-candidate")

      const aPeerMetadata: PeerMetadata = { storageId: "a" as StorageId }

      b.connect("b" as PeerId, { storageId: "b" as StorageId })
      a.connect("a" as PeerId, aPeerMetadata)

      const peerCandidate = await bPromise

      expect(peerCandidate).toMatchObject({
        peerId: "a",
        peerMetadata: aPeerMetadata,
      })

      teardown()
    })

    it("should emit disconnect events on disconnect", async () => {
      const { adapters, teardown } = await setup()
      const left = adapters[0][0]
      const right = adapters[1][0]

      const leftPeerId = "left" as PeerId
      const rightPeerId = "right" as PeerId

      const leftRepo = new Repo({
        network: [left],
        peerId: leftPeerId,
      })

      const rightRepo = new Repo({
        network: [right],
        peerId: rightPeerId,
      })

      await Promise.all([
        eventPromise(leftRepo.networkSubsystem, "peer"),
        eventPromise(rightRepo.networkSubsystem, "peer"),
      ])

      const disconnectionPromises = Promise.all([
        eventPromise(leftRepo.networkSubsystem, "peer-disconnected"),
        eventPromise(rightRepo.networkSubsystem, "peer-disconnected"),
      ])
      left.disconnect()

      await disconnectionPromises
      teardown()
    })

    it("should not send messages after disconnect", async () => {
      const { adapters, teardown } = await setup()
      const left = adapters[0][0]
      const right = adapters[1][0]

      const leftPeerId = "left" as PeerId
      const rightPeerId = "right" as PeerId

      const leftRepo = new Repo({
        network: [left],
        peerId: leftPeerId,
      })

      const rightRepo = new Repo({
        network: [right],
        peerId: rightPeerId,
      })

      await Promise.all([
        eventPromise(rightRepo.networkSubsystem, "peer"),
        eventPromise(leftRepo.networkSubsystem, "peer"),
      ])

      const disconnected = eventPromise(right, "peer-disconnected")

      left.disconnect()
      await disconnected

      const rightReceivedFromLeft = new Promise(resolve => {
        right.on("message", msg => {
          if (msg.senderId === leftPeerId) {
            resolve(null)
          }
        })
      })

      const rightReceived = Promise.race([rightReceivedFromLeft, pause(10)])

      const documentId = parseAutomergeUrl(generateAutomergeUrl()).documentId
      left.send({
        type: "foo",
        data: new Uint8Array([1, 2, 3]),
        documentId,
        senderId: leftPeerId,
        targetId: rightPeerId,
      })

      assert.equal(await rightReceived, null)
      teardown()
    })

    it("should support reconnecting after disconnect", async () => {
      const { adapters, teardown } = await setup()
      const left = adapters[0][0]
      const right = adapters[1][0]

      const leftPeerId = "left" as PeerId
      const rightPeerId = "right" as PeerId

      const _leftRepo = new Repo({
        network: [left],
        peerId: leftPeerId,
      })

      const rightRepo = new Repo({
        network: [right],
        peerId: rightPeerId,
      })

      await eventPromise(rightRepo.networkSubsystem, "peer")

      left.disconnect()

      await pause(10)

      left.connect(leftPeerId)
      await eventPromise(left, "peer-candidate")
      teardown()
    })
  })
}

const NO_OP = () => {}

type Network = NetworkAdapterInterface | NetworkAdapterInterface[]

export type SetupFn = () => Promise<{
  adapters: [Network, Network, Network]
  teardown?: () => void
}>

type TestDoc = {
  foo: string
}

const toArray = <T>(x: T | T[]) => (Array.isArray(x) ? x : [x])

const alice = "alice" as PeerId
const bob = "bob" as PeerId
const charlie = "charlie" as PeerId
