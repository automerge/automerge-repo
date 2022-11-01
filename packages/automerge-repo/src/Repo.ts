import { DocCollection } from "./DocCollection.js"
import { EphemeralData } from "./EphemeralData.js"
import {
  NetworkSubsystem,
  NetworkAdapter,
  PeerId,
  ChannelId,
} from "./network/NetworkSubsystem.js"
import { StorageSubsystem, StorageAdapter } from "./storage/StorageSubsystem.js"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"

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

    this.on("document", ({ handle }) => {
      synchronizer.addDocument(handle.documentId)
    })

    networkSubsystem.on("message", (msg) => {
      const { peerId, channelId, message } = msg
      // TODO: i think i want a more principled way of associating channels with recipients
      if (channelId.startsWith("m/")) {
        ephemeralData.receiveBroadcast(peerId, channelId, message)
      } else {
        synchronizer.onSyncMessage(peerId, channelId, message)
      }
    })
    synchronizer.on("message", ({ peerId, channelId, message }) => {
      networkSubsystem.sendMessage(peerId, channelId, message)
    })

    ephemeralData.on("message", ({ peerId, channelId, message }) => {
      networkSubsystem.sendMessage(peerId, channelId, message)
    })

    networkSubsystem.join("sync_channel" as ChannelId)
  }
}
