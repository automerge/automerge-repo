import { describe, it, expect, beforeEach } from "vitest"
import {
  NetworkAdapter,
  type NetworkAdapterInterface,
  type Message as RepoMessage,
  type PeerId as RepoPeerId,
} from "@automerge/automerge-repo"
import { NetworkAdapterConnection } from "../src/network.js"
import { PeerId, SedimentreeId } from "@automerge/automerge-subduction"

const randomBytes = (length: number): Uint8Array =>
  Uint8Array.from({ length }, () => Math.floor(Math.random() * 256))
const testBytes = () => randomBytes(64)

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
    this.emit("peer-disconnected", { peerId: peerId as RepoPeerId })
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

      expect(connection.getRemotePeerId()).toBe(remotePeerId)
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

      await expect(connection.sendBytes(testBytes())).rejects.toThrow(
        "disconnected"
      )
    })
  })

  describe("sendBytes and recvBytes", () => {
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

    it("sends bytes between peers", async () => {
      const bytes = testBytes()
      const recvPromise = bobConnection.recvBytes()
      await aliceConnection.sendBytes(bytes)
      const received = await recvPromise
      expect(received).toEqual(bytes)
    })

    it("queues bytes received before recvBytes() is called", async () => {
      const bytes = testBytes()
      await aliceConnection.sendBytes(bytes)
      await new Promise(r => setTimeout(r, 10))
      const received = await bobConnection.recvBytes()
      expect(received).toEqual(bytes)
    })

    it("filters messages from other peers", async () => {
      const otherPeerId = new PeerId(crypto.getRandomValues(new Uint8Array(32)))
      const message: RepoMessage = {
        type: "subduction-connection",
        senderId: otherPeerId.toString() as RepoMessage["senderId"],
        targetId: bobPeerId.toString() as RepoMessage["targetId"],
        data: testBytes(),
      }

      bobAdapter.emitMessage(message)

      const timeoutPromise = new Promise<null>(resolve =>
        setTimeout(() => resolve(null), 50)
      )

      const result = await Promise.race([
        bobConnection.recvBytes().then(() => "received"),
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
        bobConnection.recvBytes().then(() => "received"),
        timeoutPromise,
      ])

      expect(result).toBeNull()
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

      await expect(connection.sendBytes(testBytes())).rejects.toThrow(
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

      expect(connection.getRemotePeerId()).toBe(remotePeerId)
    })
  })

  describe("recvBytes() blocking behavior", () => {
    it("recvBytes() blocks until bytes arrive", async () => {
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
      const recvPromise = bobConnection.recvBytes().then(bytes => {
        received = true
        return bytes
      })

      await new Promise(r => setTimeout(r, 10))
      expect(received).toBe(false)

      const sentBytes = testBytes()
      await aliceConnection.sendBytes(sentBytes)

      const receivedBytes = await recvPromise
      expect(received).toBe(true)
      expect(receivedBytes).toEqual(sentBytes)
    })
  })
})
