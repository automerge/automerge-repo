import { describe, it, expect, beforeEach } from "vitest"
import {
  NetworkAdapter,
  type NetworkAdapterInterface,
  type Message as RepoMessage,
  type PeerId as RepoPeerId,
} from "@automerge/automerge-repo"
import { cbor } from "@automerge/automerge-repo/slim"
import { NetworkAdapterConnection } from "../src/network.js"
import { PeerId, Message } from "@automerge/automerge-subduction"

class MockNetworkAdapter extends NetworkAdapter {
  #peer: MockNetworkAdapter | null = null

  constructor(peerId: string) {
    super()
    this.peerId = peerId as RepoPeerId
  }

  connectTo(peer: MockNetworkAdapter): void {
    this.#peer = peer
    peer.#peer = this
  }

  connect(): void {}

  override send(message: RepoMessage): void {
    if (this.#peer) {
      this.#peer.emit("message", message)
    }
  }

  simulateDisconnect(peerId: string): void {
    this.emit("peer-disconnected", { peerId })
  }

  emitMessage(message: RepoMessage): void {
    this.emit("message", message)
  }

  disconnect(): void {}

  isReady(): boolean {
    return true
  }

  whenReady(): Promise<void> {
    return Promise.resolve()
  }
}

describe("NetworkAdapterConnection", () => {
  describe("basic connectivity", () => {
    it("returns the remote peer ID", () => {
      const adapter = new MockNetworkAdapter("local")
      const localPeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))
      const remotePeerId = new PeerId(
        crypto.getRandomValues(new Uint8Array(32))
      )

      const connection = new NetworkAdapterConnection(
        adapter as NetworkAdapterInterface,
        localPeerId,
        remotePeerId
      )

      expect(connection.peerId()).toBe(remotePeerId)
    })

    it("can disconnect", async () => {
      const adapter = new MockNetworkAdapter("local")
      const localPeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))
      const remotePeerId = new PeerId(
        crypto.getRandomValues(new Uint8Array(32))
      )

      const connection = new NetworkAdapterConnection(
        adapter as NetworkAdapterInterface,
        localPeerId,
        remotePeerId
      )

      await connection.disconnect()

      await expect(connection.send(Message.blobsRequest([]))).rejects.toThrow(
        "disconnected"
      )
    })
  })

  describe("send and receive", () => {
    let aliceAdapter: MockNetworkAdapter
    let bobAdapter: MockNetworkAdapter
    let alicePeerId: PeerId
    let bobPeerId: PeerId
    let aliceConnection: NetworkAdapterConnection
    let bobConnection: NetworkAdapterConnection

    beforeEach(() => {
      aliceAdapter = new MockNetworkAdapter("alice")
      bobAdapter = new MockNetworkAdapter("bob")
      aliceAdapter.connectTo(bobAdapter)

      alicePeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))
      bobPeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))

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

    it("sends messages between peers", async () => {
      const message = Message.blobsRequest([])
      const recvPromise = bobConnection.recv()
      await aliceConnection.send(message)
      const received = await recvPromise
      expect(received.type).toBe("BlobsRequest")
    })

    it("queues messages received before recv() is called", async () => {
      const message = Message.blobsRequest([])
      await aliceConnection.send(message)
      await new Promise(r => setTimeout(r, 10))
      const received = await bobConnection.recv()
      expect(received.type).toBe("BlobsRequest")
    })

    it("filters messages from other peers", async () => {
      const otherPeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))
      const message: RepoMessage = {
        type: "subduction-connection",
        senderId: otherPeerId.toString() as RepoMessage["senderId"],
        targetId: bobPeerId.toString() as RepoMessage["targetId"],
        data: cbor.encode(Message.blobsRequest([])),
      }

      bobAdapter.emitMessage(message)

      const timeoutPromise = new Promise<null>(resolve =>
        setTimeout(() => resolve(null), 50)
      )

      const result = await Promise.race([
        bobConnection.recv().then(() => "received"),
        timeoutPromise,
      ])

      expect(result).toBeNull()
    })

    it("filters non-subduction messages", async () => {
      const message: RepoMessage = {
        type: "sync",
        senderId: alicePeerId.toString() as RepoMessage["senderId"],
        targetId: bobPeerId.toString() as RepoMessage["targetId"],
        data: new Uint8Array([1, 2, 3]),
      }

      bobAdapter.emitMessage(message)

      const timeoutPromise = new Promise<null>(resolve =>
        setTimeout(() => resolve(null), 50)
      )

      const result = await Promise.race([
        bobConnection.recv().then(() => "received"),
        timeoutPromise,
      ])

      expect(result).toBeNull()
    })
  })

  describe("nextRequestId", () => {
    it("generates unique request IDs", async () => {
      const adapter = new MockNetworkAdapter("local")
      const localPeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))
      const remotePeerId = new PeerId(
        crypto.getRandomValues(new Uint8Array(32))
      )

      const connection = new NetworkAdapterConnection(
        adapter as NetworkAdapterInterface,
        localPeerId,
        remotePeerId
      )

      const id1 = await connection.nextRequestId()
      const id2 = await connection.nextRequestId()

      expect(id1.nonce.bytes).not.toEqual(id2.nonce.bytes)
    })

    it("uses the local peer ID as requestor", async () => {
      const adapter = new MockNetworkAdapter("local")
      const localPeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))
      const remotePeerId = new PeerId(
        crypto.getRandomValues(new Uint8Array(32))
      )

      const connection = new NetworkAdapterConnection(
        adapter as NetworkAdapterInterface,
        localPeerId,
        remotePeerId
      )

      const reqId = await connection.nextRequestId()

      expect(reqId.requestor).toBeDefined()
    })
  })

  describe("peer disconnection", () => {
    it("handles peer disconnection", async () => {
      const adapter = new MockNetworkAdapter("local")
      const localPeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))
      const remotePeerId = new PeerId(
        crypto.getRandomValues(new Uint8Array(32))
      )

      const connection = new NetworkAdapterConnection(
        adapter as NetworkAdapterInterface,
        localPeerId,
        remotePeerId
      )

      adapter.simulateDisconnect(remotePeerId.toString())

      await expect(connection.send(Message.blobsRequest([]))).rejects.toThrow(
        "disconnected"
      )
    })

    it("ignores disconnection of other peers", async () => {
      const adapter = new MockNetworkAdapter("local")
      const localPeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))
      const remotePeerId = new PeerId(
        crypto.getRandomValues(new Uint8Array(32))
      )
      const otherPeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))

      const connection = new NetworkAdapterConnection(
        adapter as NetworkAdapterInterface,
        localPeerId,
        remotePeerId
      )

      adapter.simulateDisconnect(otherPeerId.toString())

      expect(connection.peerId()).toBe(remotePeerId)
    })
  })

  describe("recv() blocking behavior", () => {
    it("recv() blocks until a message arrives", async () => {
      const aliceAdapter = new MockNetworkAdapter("alice")
      const bobAdapter = new MockNetworkAdapter("bob")
      aliceAdapter.connectTo(bobAdapter)

      const alicePeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))
      const bobPeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))

      const aliceConnection = new NetworkAdapterConnection(
        aliceAdapter as NetworkAdapterInterface,
        alicePeerId,
        bobPeerId
      )

      const bobConnection = new NetworkAdapterConnection(
        bobAdapter as NetworkAdapterInterface,
        bobPeerId,
        alicePeerId
      )

      let received = false
      const recvPromise = bobConnection.recv().then(msg => {
        received = true
        return msg
      })

      await new Promise(r => setTimeout(r, 10))
      expect(received).toBe(false)

      await aliceConnection.send(Message.blobsRequest([]))

      const msg = await recvPromise
      expect(received).toBe(true)
      expect(msg.type).toBe("BlobsRequest")
    })
  })
})
