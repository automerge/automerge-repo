import { DocCollection } from "./DocCollection"
import { EphemeralData } from "./EphemeralData"
import { NetworkSubsystem } from "./network/NetworkSubsystem"
import { StorageSubsystem } from "./storage/StorageSubsystem"
import { StorageAdapter } from "./storage/StorageAdapter"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer"
import { ChannelId, PeerId } from "./types"
import { NetworkAdapter } from "./network/NetworkAdapter"

import debug from "debug"

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
    sharePolicy = () => true,
  }: RepoConfig) {
    super()

    this.#log = debug(`ar:repo:${peerId}`)

    if (storage) {
      const storageSubsystem = new StorageSubsystem(storage)
      this.storageSubsystem = storageSubsystem
      this.on("document", async ({ handle }) => {
        handle.on("change", ({ handle }) =>
          storageSubsystem.save(handle.documentId, handle.doc)
        )

        const binary = await storageSubsystem.load(handle.documentId)
        if (binary.byteLength > 0) {
          handle.loadIncremental(binary)
        } else {
          handle.requestDocument()
        }
      })
    } else {
      this.on("document", async ({ handle }) => {
        handle.requestDocument()
      })
    }

    const networkSubsystem = new NetworkSubsystem(network, peerId)
    this.networkSubsystem = networkSubsystem

    const ephemeralData = new EphemeralData()
    this.ephemeralData = ephemeralData

    // wire up the dependency synchronizers
    const synchronizer = new CollectionSynchronizer(this)

    networkSubsystem.on("peer", ({ peerId }) => {
      this.#log("peer connected", { peerId })
      synchronizer.addPeer(peerId, sharePolicy(peerId))
    })

    networkSubsystem.on("peer-disconnected", ({ peerId }) => {
      synchronizer.removePeer(peerId)
    })

    this.on("document", ({ handle }) => {
      synchronizer.addDocument(handle.documentId)
    })

    networkSubsystem.on("message", payload => {
      const { senderId, channelId, message } = payload
      // TODO: this demands a more principled way of associating channels with recipients
      if (channelId.startsWith("m/")) {
        this.#log(`receiving ephemeral message from ${senderId}`)
        ephemeralData.receive(senderId, channelId, message)
      } else {
        this.#log(`receiving sync message from ${senderId}`)
        synchronizer.onSyncMessage(senderId, channelId, message)
      }
    })

    synchronizer.on(
      "message",
      ({ targetId, channelId, message, broadcast }) => {
        this.#log(`sending sync message to ${targetId}`)
        networkSubsystem.sendMessage(targetId, channelId, message, broadcast)
      }
    )

    ephemeralData.on(
      "message",
      ({ targetId, channelId, message, broadcast }) => {
        this.#log(`sending ephemeral message to ${targetId}`)
        networkSubsystem.sendMessage(targetId, channelId, message, broadcast)
      }
    )

    networkSubsystem.join("sync_channel" as ChannelId)
  }
}

export interface RepoConfig {
  storage?: StorageAdapter
  network: NetworkAdapter[]
  peerId?: PeerId
  sharePolicy?: (peerId: PeerId) => boolean // generous or no. this is a stand-in for a better API to test an idea.
}
