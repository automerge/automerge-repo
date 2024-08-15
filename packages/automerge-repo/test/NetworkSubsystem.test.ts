import assert from "assert"
import { describe, it } from "vitest"
import { NetworkSubsystem } from "../src/network/NetworkSubsystem.js"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter.js"
import { PeerId, PeerMetadata, StorageId } from "../src/index.js"

// Note: The sync tests in `Repo.test.ts` exercise the network subsystem, and the suite in
// `automerge-repo` provides test utilities that individual adapters can
// use to ensure that they work correctly.

describe("Network subsystem", () => {
  const setup = ({ startReady = true } = {}) => {
    const networkAdapter = new DummyNetworkAdapter({ startReady })
    const peerId = "peerId" as PeerId
    const peerMetadata: Promise<PeerMetadata> = Promise.resolve({
      storageId: "no-such-id" as StorageId,
      isEphemeral: true,
    })
    return { networkAdapter, peerId, peerMetadata }
  }

  it("Can be instantiated with no network adapters", () => {
    const { peerId, peerMetadata } = setup()
    const network = new NetworkSubsystem([], peerId, peerMetadata)
    assert(network !== null)
  })

  it("can be instantiated with a network adapter", async () => {
    const { networkAdapter, peerId, peerMetadata } = setup()
    const network = new NetworkSubsystem([networkAdapter], peerId, peerMetadata)
    assert(
      network instanceof NetworkSubsystem,
      "Network should be an instance of NetworkSubsystem"
    )
  })

  it("should become ready with a ready adapter", async () => {
    const { networkAdapter, peerId, peerMetadata } = setup()
    const network = new NetworkSubsystem([networkAdapter], peerId, peerMetadata)
    await network.whenReady()
    assert.strictEqual(
      network.isReady(),
      true,
      "Network should be ready with a ready adapter"
    )
  })

  it("allows adding a network adapter after creation", async () => {
    const { networkAdapter, peerId, peerMetadata } = setup({
      startReady: false,
    })
    const network = new NetworkSubsystem([], peerId, peerMetadata)
    network.addNetworkAdapter(networkAdapter)
    assert(
      network instanceof NetworkSubsystem,
      "Network should be an instance of NetworkSubsystem"
    )
  })

  it("does not become ready prematurely when adapter is not ready", async () => {
    const { networkAdapter, peerId, peerMetadata } = setup({
      startReady: false,
    })
    const network = new NetworkSubsystem([], peerId, peerMetadata)
    network.addNetworkAdapter(networkAdapter)
    assert.strictEqual(
      network.isReady(),
      false,
      "Network should not be ready immediately when adapter is not ready"
    )
  })

  it("allows removing a network adapter after creation", async () => {
    const { networkAdapter, peerId, peerMetadata } = setup()
    const network = new NetworkSubsystem([networkAdapter], peerId, peerMetadata)
    network.removeNetworkAdapter(networkAdapter)
    assert(network !== null)
    assert(network.adapters.length == 0)
    assert.strictEqual(
      network.isReady(),
      true,
      "An empty network subsystem is ready after removing the adapter"
    )
  })

  it("handles ready behaviour for multiple network adapters correctly", async () => {
    const { networkAdapter, peerId, peerMetadata } = setup()
    const network = new NetworkSubsystem([networkAdapter], peerId, peerMetadata)

    const anotherAdapter = new DummyNetworkAdapter({ startReady: true })
    network.addNetworkAdapter(anotherAdapter)

    await network.whenReady()
    assert.strictEqual(
      network.isReady(),
      true,
      "Network should be ready when all adapters are ready"
    )

    network.removeNetworkAdapter(networkAdapter)
    assert.strictEqual(
      network.isReady(),
      true,
      "Network should remain ready when at least one adapter is still ready"
    )
  })
})
