import { DocCollection } from "./DocCollection.js"
import { EphemeralData } from "./EphemeralData.js"
import { NetworkAdapter } from "./network/NetworkAdapter.js"
import { NetworkSubsystem } from "./network/NetworkSubsystem.js"
import { StorageAdapter } from "./storage/StorageAdapter.js"
import { StorageSubsystem } from "./storage/StorageSubsystem.js"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"
import { DocumentId, EphemeralMessage, PeerId, SyncMessage } from "./types.js"

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
    peerId = "WHY DON'T YOU HAVE A PEER ID" as PeerId,
    sharePolicy,
  }: RepoConfig) {
    super()
    this.#log = debug(`automerge-repo:repo`)
    this.sharePolicy = sharePolicy ?? this.sharePolicy

    // DOC COLLECTION

    // The `document` event is fired by the DocCollection any time we create a new document or look
    // up a document by ID. We listen for it in order to wire up storage and network synchronization.
    this.on("document", async ({ handle }) => {
      if (storageSubsystem) {
        // Save when the document changes
        handle.on("change", async ({ handle }) => {
          const doc = await handle.value()
          storageSubsystem.save(handle.documentId, doc)
        })

        // Try to load from disk
        const binary = await storageSubsystem.loadBinary(handle.documentId)
        handle.load(binary)
      }

      // Advertise our interest in the document
      handle.request()

      // Register the document with the synchronizer
      synchronizer.addDocument(handle.documentId)
    })

    this.on("delete-document", ({ documentId }) => {
      // TODO Pass the delete on to the network
      // synchronizer.removeDocument(documentId)

      storageSubsystem?.remove(documentId)
    })

    // SYNCHRONIZER
    // The synchronizer uses the network subsystem to keep documents in sync with peers.

    const synchronizer = new CollectionSynchronizer(this)

    // When the synchronizer emits sync messages, send them to peers
    synchronizer.on("message", message => {
      this.#log(`sending sync message to ${message.recipientId}`)
      networkSubsystem.sendMessage(message)
    })

    // STORAGE
    // The storage subsystem has access to some form of persistence, and deals with save and loading documents.

    const storageSubsystem = storage ? new StorageSubsystem(storage) : undefined
    this.storageSubsystem = storageSubsystem

    // NETWORK
    // The network subsystem deals with sending and receiving messages to and from peers.

    const networkSubsystem = new NetworkSubsystem(network, peerId)
    this.networkSubsystem = networkSubsystem

    // When we get a new peer, register it with the synchronizer
    networkSubsystem.on("peer", async ({ peerId }) => {
      this.#log("peer connected", { peerId })
      await synchronizer.addPeer(peerId)
    })

    // When a peer disconnects, remove it from the synchronizer
    networkSubsystem.on("peer-disconnected", ({ peerId }) => {
      synchronizer.removePeer(peerId)
    })

    // Handle incoming messages
    networkSubsystem.on("message", async message => {
      switch (message.type) {
        case "SYNC":
          this.#log(`receiving sync message from ${message.senderId}`)
          await synchronizer.receiveSyncMessage(message)
          break

        case "EPHEMERAL":
          this.#log(`receiving ephemeral message from ${message.senderId}`)
          ephemeralData.receive(message)
          break
      }
    })

    // EPHEMERAL DATA
    // The ephemeral data subsystem uses the network to send and receive messages that are not
    // persisted to storage, e.g. cursor position, presence, etc.

    const ephemeralData = new EphemeralData()
    this.ephemeralData = ephemeralData

    // Listen for new ephemeral messages and pass them to peers
    ephemeralData.on("sending", ({ documentId, encodedMessage }) => {
      const message: EphemeralMessage = {
        type: "EPHEMERAL",
        senderId: peerId,
        recipientId: BROADCAST,
        payload: {
          documentId,
          encodedMessage,
        },
      }
      this.#log(`sending ephemeral message`)
      networkSubsystem.sendMessage(message)
    })
  }
}

export interface RepoConfig {
  /** Our unique identifier */
  peerId?: PeerId // TODO this should be required

  /** A storage adapter can be provided, or not */
  storage?: StorageAdapter

  /** One or more network adapters must be provided */
  network: NetworkAdapter[]

  /**
   * Normal peers typically share generously with everyone (meaning we sync all our documents with
   * all peers). A server only syncs documents that a peer explicitly requests by ID.
   */
  sharePolicy?: SharePolicy
}

export type SharePolicy = (
  peerId: PeerId,
  documentId?: DocumentId
) => Promise<boolean>

export const BROADCAST = "*" as PeerId
