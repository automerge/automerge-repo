import { DocCollection } from "./DocCollection"
import { EphemeralData } from "./EphemeralData"
import { NetworkSubsystem } from "./network/NetworkSubsystem"
import { StorageAdapter, StorageSubsystem } from "./storage/StorageSubsystem"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer"
import { ChannelId, NetworkAdapter, PeerId } from "./types"

export interface RepoConfig {
  storage?: StorageAdapter
  network: NetworkAdapter[]
  peerId?: PeerId
  sharePolicy?: (peerId: PeerId) => boolean // generous or no. this is a stand-in for a better API to test an idea.
}

export class Repo extends DocCollection {
  networkSubsystem: NetworkSubsystem
  storageSubsystem?: StorageSubsystem
  ephemeralData: EphemeralData

  constructor(config: RepoConfig) {
    super()
    const { storage, network, peerId, sharePolicy = () => true } = config

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
          handle.unblockSync()
        }
      })
    } else {
      this.on("document", async ({ handle }) => {
        handle.unblockSync()
      })
    }

    const networkSubsystem = new NetworkSubsystem(network, peerId)
    this.networkSubsystem = networkSubsystem

    const synchronizer = new CollectionSynchronizer(this)
    const ephemeralData = new EphemeralData()
    this.ephemeralData = ephemeralData

    // wire up the dependency synchronizers.
    networkSubsystem.on("peer", ({ peerId }) => {
      synchronizer.addPeer(peerId, sharePolicy(peerId))
    })

    networkSubsystem.on("peer-disconnected", ({ peerId }) => {
      synchronizer.removePeer(peerId)
    })

    this.on("document", ({ handle }) => {
      synchronizer.addDocument(handle.documentId)
    })

    networkSubsystem.on("message", msg => {
      const { senderId, channelId, message } = msg

      // TODO: this demands a more principled way of associating channels with recipients
      if (channelId.startsWith("m/")) {
        ephemeralData.receive(senderId, channelId, message)
      } else {
        synchronizer.onSyncMessage(senderId, channelId, message)
      }
    })

    synchronizer.on(
      "message",
      ({ targetId, channelId, message, broadcast }) => {
        networkSubsystem.sendMessage(targetId, channelId, message, broadcast)
      }
    )

    ephemeralData.on(
      "message",
      ({ targetId, channelId, message, broadcast }) => {
        networkSubsystem.sendMessage(targetId, channelId, message, broadcast)
      }
    )

    networkSubsystem.join("sync_channel" as ChannelId)
  }
}
