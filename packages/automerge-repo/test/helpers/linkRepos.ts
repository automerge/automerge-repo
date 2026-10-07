import { DummyNetworkAdapter } from "../../src/helpers/DummyNetworkAdapter.js"
import { eventPromise } from "../../src/helpers/eventPromise.js"
import type { Message, PeerId } from "../../src/index.js"
import type { Repo } from "../../src/Repo.js"

/** Resolves once the network subsystem has connected the adapter. */
const whenConnected = (adapter: DummyNetworkAdapter): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  const connect = adapter.connect.bind(adapter)
  adapter.connect = (peerId: PeerId) => {
    connect(peerId)
    resolve()
  }
  return promise
}

/**
 * Connects two repos with a fresh adapter pair and resolves once each has
 * the other as a peer, announcing each repo's storage id. Counts the sync bytes `left` sends to `right`.
 * Delivery takes a macrotask, so an exchange that never converges still
 * lets a test's failure budget fire. `unlink` disconnects both sides.
 */
export async function linkRepos(left: Repo, right: Repo) {
  const stats = { bytesToRight: 0 }
  let toLeft!: DummyNetworkAdapter
  const toRight: DummyNetworkAdapter = new DummyNetworkAdapter({
    startReady: true,
    sendMessage: (message: Message) => {
      if ("data" in message && message.data) {
        stats.bytesToRight += message.data.byteLength
      }
      setImmediate(() => toLeft.receive(message))
    },
  })
  toLeft = new DummyNetworkAdapter({
    startReady: true,
    sendMessage: (message: Message) =>
      setImmediate(() => toRight.receive(message)),
  })
  // DummyNetworkAdapter drops messages until it is connected, which waits
  // for the repo's storage id.
  const connected = Promise.all([whenConnected(toRight), whenConnected(toLeft)])
  left.networkSubsystem.addNetworkAdapter(toRight)
  right.networkSubsystem.addNetworkAdapter(toLeft)
  await connected
  const peered = Promise.all([
    eventPromise(left.networkSubsystem, "peer"),
    eventPromise(right.networkSubsystem, "peer"),
  ])
  const metadataOf = async (repo: Repo) => ({
    storageId: await repo.storageId(),
    isEphemeral: repo.storageSubsystem === undefined,
  })
  toRight.emit("peer-candidate", {
    peerId: right.peerId,
    peerMetadata: await metadataOf(right),
  })
  toLeft.emit("peer-candidate", {
    peerId: left.peerId,
    peerMetadata: await metadataOf(left),
  })
  await peered

  const unlink = () => {
    toRight.emit("peer-disconnected", { peerId: right.peerId })
    toLeft.emit("peer-disconnected", { peerId: left.peerId })
    toRight.disconnect()
    toLeft.disconnect()
  }
  return { stats, unlink }
}
