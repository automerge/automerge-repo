import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  type NetworkAdapterInterface,
  type PeerId as RepoPeerId,
} from "@automerge/automerge-repo"
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel"
import { NetworkAdapterConnection } from "../src/network.js"
import { PeerId, Message, SedimentreeId } from "@automerge/automerge-subduction"

const randomBytes = (length: number): Uint8Array =>
  Uint8Array.from({ length }, () => Math.floor(Math.random() * 256))
const testSedimentreeId = () => SedimentreeId.fromBytes(randomBytes(32))
const testMessage = () => Message.blobsRequest(testSedimentreeId(), [])

describe("NetworkAdapterConnection with BroadcastChannelNetworkAdapter", () => {
  let aliceAdapter: BroadcastChannelNetworkAdapter
  let bobAdapter: BroadcastChannelNetworkAdapter
  let alicePeerId: PeerId
  let bobPeerId: PeerId
  let aliceRepoPeerId: RepoPeerId
  let bobRepoPeerId: RepoPeerId
  let aliceConnection: NetworkAdapterConnection
  let bobConnection: NetworkAdapterConnection

  beforeEach(async () => {
    const channelName = `test-${crypto.randomUUID()}`

    aliceAdapter = new BroadcastChannelNetworkAdapter({ channelName })
    bobAdapter = new BroadcastChannelNetworkAdapter({ channelName })

    alicePeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))
    bobPeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))

    aliceRepoPeerId = alicePeerId.toString() as RepoPeerId
    bobRepoPeerId = bobPeerId.toString() as RepoPeerId

    const alicePeerDiscovered = new Promise<void>(resolve => {
      aliceAdapter.on("peer-candidate", ({ peerId }) => {
        if (peerId === bobRepoPeerId) resolve()
      })
    })

    const bobPeerDiscovered = new Promise<void>(resolve => {
      bobAdapter.on("peer-candidate", ({ peerId }) => {
        if (peerId === aliceRepoPeerId) resolve()
      })
    })

    aliceAdapter.connect(aliceRepoPeerId)
    bobAdapter.connect(bobRepoPeerId)

    await Promise.all([alicePeerDiscovered, bobPeerDiscovered])

    aliceConnection = new NetworkAdapterConnection(
      aliceAdapter as NetworkAdapterInterface,
      alicePeerId,
      bobPeerId
    )

    bobConnection = new NetworkAdapterConnection(
      bobAdapter as NetworkAdapterInterface,
      bobPeerId,
      alicePeerId
    )
  })

  afterEach(() => {
    aliceAdapter.disconnect()
    bobAdapter.disconnect()
  })

  it("sends messages through BroadcastChannel", async () => {
    const message = testMessage()
    const recvPromise = bobConnection.recv()
    await aliceConnection.send(message)
    const received = await recvPromise
    expect(received.type).toBe("BlobsRequest")
  })

  it("sends messages in both directions", async () => {
    const aliceRecvPromise = aliceConnection.recv()
    const bobRecvPromise = bobConnection.recv()

    await aliceConnection.send(testMessage())
    await bobConnection.send(testMessage())

    const [aliceReceived, bobReceived] = await Promise.all([
      aliceRecvPromise,
      bobRecvPromise,
    ])

    expect(aliceReceived.type).toBe("BlobsRequest")
    expect(bobReceived.type).toBe("BlobsRequest")
  })

  it("handles peer disconnection", async () => {
    const disconnectReceived = new Promise<void>(resolve => {
      aliceAdapter.on("peer-disconnected", ({ peerId }) => {
        if (peerId === bobRepoPeerId) resolve()
      })
    })

    bobAdapter.disconnect()
    await disconnectReceived

    await expect(aliceConnection.send(testMessage())).rejects.toThrow(
      "disconnected"
    )
  })
})
