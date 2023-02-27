import { DocCollection } from "./DocCollection"
import { EphemeralData } from "./EphemeralData"
import { NetworkSubsystem } from "./network/NetworkSubsystem"
import { StorageSubsystem } from "./storage/StorageSubsystem"
import { StorageAdapter } from "./storage/StorageAdapter"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer"
import { ChannelId, PeerId } from "./types"
import { NetworkAdapter } from "./network/NetworkAdapter"

import debug from "debug"

const SYNC_CHANNEL = "sync_channel" as ChannelId

/** By default, we share generously with all peers. */
const GENEROUS_SHARE_POLICY = () => true

/** A Repo is a DocCollection with networking, syncing, and storage capabilities. */
export class Repo extends DocCollection {
  #log: debug.Debugger

  networkSubsystem: NetworkSubsystem
  storageSubsystem?: StorageSubsystem
  ephemeralData: EphemeralData

  constructor({
    storage,
    network,
    peerId,
    sharePolicy = GENEROUS_SHARE_POLICY,
  }: RepoConfig) {
    super()

    this.#log = debug(`ar:repo:${peerId}`)

    const storageSubsystem = storage ? new StorageSubsystem(storage) : undefined
    this.storageSubsystem = storageSubsystem

    const networkSubsystem = new NetworkSubsystem(network, peerId)
    this.networkSubsystem = networkSubsystem

    const ephemeralData = new EphemeralData()
    this.ephemeralData = ephemeralData

    // wire up the dependency synchronizers
    const synchronizer = new CollectionSynchronizer(this)

    // DocCollection emits `document` when a document is created or requested
    this.on("document", async ({ handle }) => {
      if (storageSubsystem) {
        // Try to load from disk
        const binary = await storageSubsystem.loadBinary(handle.documentId)
        handle.loadIncremental(binary)

        // Save when the document changes
        handle.on("change", ({ handle }) =>
          storageSubsystem.save(handle.documentId, handle.doc)
        )
      }

      // Advertise our interest in the document
      handle.request()

      // Register the document with the synchronizer
      synchronizer.addDocument(handle.documentId)
    })

    // When we get a new peer, register it with the synchronizer
    networkSubsystem.on("peer", ({ peerId }) => {
      this.#log("peer connected", { peerId })
      synchronizer.addPeer(peerId, sharePolicy(peerId))
    })

    // When a peer disconnects, remove it from the synchronizer
    networkSubsystem.on("peer-disconnected", ({ peerId }) => {
      synchronizer.removePeer(peerId)
    })

    // Handle incoming message from peers
    networkSubsystem.on("message", payload => {
      const { senderId, channelId, message } = payload
      // TODO: this demands a more principled way of associating channels with recipients

      if (channelId.startsWith("m/")) {
        // Ephemeral message
        this.#log(`receiving ephemeral message from ${senderId}`)
        ephemeralData.receive(senderId, channelId, message)
      } else {
        // Sync message
        this.#log(`receiving sync message from ${senderId}`)
        synchronizer.onSyncMessage(senderId, channelId, message)
      }
    })

    // Send sync messages to peers
    synchronizer.on(
      "message",
      ({ targetId, channelId, message, broadcast }) => {
        this.#log(`sending sync message to ${targetId}`)
        networkSubsystem.sendMessage(targetId, channelId, message, broadcast)
      }
    )

    // Send ephemeral messages to peers
    ephemeralData.on(
      "message",
      ({ targetId, channelId, message, broadcast }) => {
        this.#log(`sending ephemeral message to ${targetId}`)
        networkSubsystem.sendMessage(targetId, channelId, message, broadcast)
      }
    )

    networkSubsystem.join(SYNC_CHANNEL)
  }
}

export interface RepoConfig {
  storage?: StorageAdapter
  network: NetworkAdapter[]
  peerId?: PeerId
  sharePolicy?: (peerId: PeerId) => boolean // generous or no. this is a stand-in for a better API to test an idea.
}
