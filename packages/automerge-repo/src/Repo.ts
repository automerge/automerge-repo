import { DocCollection } from "./DocCollection.js"
import { EphemeralData } from "./EphemeralData.js"
import { NetworkAdapter } from "./network/NetworkAdapter.js"
import { NetworkSubsystem } from "./network/NetworkSubsystem.js"
import { StorageAdapter } from "./storage/StorageAdapter.js"
import { StorageSubsystem } from "./storage/StorageSubsystem.js"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"
import { ChannelId, PeerId } from "./types.js"
import { AuthProvider, SharePolicy } from "./auth/AuthProvider.js"

import debug from "debug"

const SYNC_CHANNEL = "sync_channel" as ChannelId

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
    sharePolicy,
    authProvider,
    idGenerator,
  }: RepoConfig) {
    super()
    this.#log = debug(`automerge-repo:repo:${peerId}`)

    if (sharePolicy) this.sharePolicy = sharePolicy

    // DOC COLLECTION

    // The `document` event is fired by the DocCollection any time we create a new document or look
    // up a document by ID. We listen for it in order to wire up storage and network synchronization.
    this.on("document", async ({ handle }) => {
      if (storageSubsystem) {
        // Try to load from disk
        const binary = await storageSubsystem.loadBinary(handle.documentId)
        handle.load(binary)

        // Save when the document changes
        handle.on("change", async ({ handle }) => {
          const doc = await handle.value()
          storageSubsystem.save(handle.documentId, doc)
        })
      }

      // Advertise our interest in the document
      handle.request()

      // Register the document with the synchronizer
      synchronizer.addDocument(handle.documentId)
    })

    // SYNCHRONIZER
    // The synchronizer uses the network subsystem to keep documents in sync with peers.

    const synchronizer = new CollectionSynchronizer(this)

    // When the synchronizer emits sync messages, send them to peers
    synchronizer.on(
      "message",
      ({ targetId, channelId, message, broadcast }) => {
        this.#log(`sending sync message to ${targetId}`)
        networkSubsystem.sendMessage(targetId, channelId, message, broadcast)
      }
    )

    // STORAGE
    // The storage subsystem has access to some form of persistence, and deals with save and loading documents.

    const storageSubsystem = storage ? new StorageSubsystem(storage) : undefined
    this.storageSubsystem = storageSubsystem

    // NETWORK
    // The network subsystem deals with sending and receiving messages to and from peers.

    const networkSubsystem = new NetworkSubsystem(network, peerId)
    this.networkSubsystem = networkSubsystem

    // When we get a new peer, register it with the synchronizer
    networkSubsystem.on("peer", ({ peerId }) => {
      this.#log("peer connected", { peerId })
      synchronizer.addPeer(peerId)
    })

    // When a peer disconnects, remove it from the synchronizer
    networkSubsystem.on("peer-disconnected", ({ peerId }) => {
      synchronizer.removePeer(peerId)
    })

    // Handle incoming messages
    networkSubsystem.on("message", msg => {
      const { senderId, channelId, message } = msg

      // TODO: this demands a more principled way of associating channels with recipients

      // Ephemeral channel ids start with "m/"
      if (channelId.startsWith("m/")) {
        // Ephemeral message
        this.#log(`receiving ephemeral message from ${senderId}`)
        ephemeralData.receive(senderId, channelId, message)
      } else {
        // Sync message
        this.#log(`receiving sync message from ${senderId}`)
        synchronizer.receiveSyncMessage(senderId, channelId, message)
      }
    })

    // We establish a special channel for sync messages
    networkSubsystem.join(SYNC_CHANNEL)

    // EPHEMERAL DATA
    // The ephemeral data subsystem uses the network to send and receive messages that are not
    // persisted to storage, e.g. cursor position, presence, etc.

    const ephemeralData = new EphemeralData()
    this.ephemeralData = ephemeralData

    // Send ephemeral messages to peers
    ephemeralData.on(
      "message",
      ({ targetId, channelId, message, broadcast }) => {
        this.#log(`sending ephemeral message to ${targetId}`)
        networkSubsystem.sendMessage(targetId, channelId, message, broadcast)
      }
    )
  }
}

export interface RepoConfig {
  /** Our unique identifier */
  peerId?: PeerId

  /** A storage adapter can be provided, or not */
  storage?: StorageAdapter

  /** One or more network adapters must be provided */
  network: NetworkAdapter[]

  /**
   * Normal peers typically share generously with everyone (meaning we sync all our documents with
   * all peers). A server only syncs documents that a peer explicitly requests by ID.
   */
  sharePolicy?: SharePolicy

  /** An auth provider can be provided, or not */
  authProvider?: AuthProvider
}
