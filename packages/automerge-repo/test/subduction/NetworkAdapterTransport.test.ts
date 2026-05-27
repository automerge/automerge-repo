import { describe, it, expect } from "vitest"
import { DummyNetworkAdapter } from "../../src/helpers/DummyNetworkAdapter.js"
import { NetworkAdapterTransport } from "../../src/subduction/network.js"
import type { PeerId } from "../../src/types.js"

describe("NetworkAdapterTransport", () => {
  it("recvBytes() rejects when adapter fires peer-disconnected", async () => {
    const adapter = new DummyNetworkAdapter()
    adapter.connect("local-peer" as PeerId)
    const transport = new NetworkAdapterTransport(
      adapter,
      "local-peer" as PeerId,
      "remote-peer" as PeerId
    )

    const recvPromise = transport.recvBytes()

    // Simulate adapter peer going away
    adapter.emit("peer-disconnected", { peerId: "remote-peer" })

    await expect(recvPromise).rejects.toThrow("Connection is disconnected")
  })

  it("recvBytes() rejects immediately when already disconnected", async () => {
    const adapter = new DummyNetworkAdapter()
    adapter.connect("local-peer" as PeerId)
    const transport = new NetworkAdapterTransport(
      adapter,
      "local-peer" as PeerId,
      "remote-peer" as PeerId
    )

    adapter.emit("peer-disconnected", { peerId: "remote-peer" })

    await expect(transport.recvBytes()).rejects.toThrow("Connection is disconnected")
  })
})
