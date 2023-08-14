import { DocCollection } from "./DocCollection.js"
import { EphemeralData } from "./EphemeralData.js"
import { isEphemeralMessage, NetworkAdapter } from "./network/NetworkAdapter.js"
import { NetworkSubsystem } from "./network/NetworkSubsystem.js"
import { StorageAdapter } from "./storage/StorageAdapter.js"
import { StorageSubsystem } from "./storage/StorageSubsystem.js"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"
import { ChannelId, DocumentId, PeerId } from "./types.js"

import debug from "debug"

/** A Repo is a DocCollection with networking, syncing, and storage capabilities. */
export class Repo extends DocCollection {
  #log: debug.Debugger

  networkSubsystem: NetworkSubsystem
  storageSubsystem?: StorageSubsystem
  ephemeralData: EphemeralData

  constructor({ storage, network, peerId, sharePolicy }: RepoConfig) {
    super()
    this.#log = debug(`automerge-repo:repo`)
    this.sharePolicy = sharePolicy ?? this.sharePolicy

    // DOC COLLECTION

    // The `document` event is fired by the DocCollection any time we create a new document or look
    // up a document by ID. We listen for it in order to wire up storage and network synchronization.
    this.on("document", async ({ handle }) => {
      if (storageSubsystem) {
        // Save when the document changes
        handle.on("heads-changed", async ({ handle, doc }) => {
          await storageSubsystem.saveDoc(handle.documentId, doc)
        })

        // Try to load from disk
        const loadedDoc = await storageSubsystem.loadDoc(handle.documentId)
        if (loadedDoc) {
          handle.update(() => loadedDoc)
        }
      }

      handle.on("unavailable", () => {
        this.#log("document unavailable", { documentId: handle.documentId })
        this.emit("unavailable-document", {
          encodedDocumentId: handle.documentId,
        })
      })

      handle.request()

      // Register the document with the synchronizer. This advertises our interest in the document.
      synchronizer.addDocument(handle.documentId)
    })

    this.on("delete-document", ({ encodedDocumentId }) => {
      // TODO Pass the delete on to the network
      // synchronizer.removeDocument(documentId)

      if (storageSubsystem) {
        storageSubsystem.remove(encodedDocumentId)
      }
    })

    // SYNCHRONIZER
    // The synchronizer uses the network subsystem to keep documents in sync with peers.

    const synchronizer = new CollectionSynchronizer(this)

    // When the synchronizer emits sync messages, send them to peers
    synchronizer.on("message", message => {
      this.#log(`sending sync message to ${message.targetId}`)
      networkSubsystem.send(message)
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
      synchronizer.addPeer(peerId)
    })

    // When a peer disconnects, remove it from the synchronizer
    networkSubsystem.on("peer-disconnected", ({ peerId }) => {
      synchronizer.removePeer(peerId)
    })

    // Handle incoming messages
    networkSubsystem.on("message", async msg => {
      if (isEphemeralMessage(msg)) {
        // Ephemeral message
        this.#log(`receiving ephemeral message from ${msg.senderId}`)
        ephemeralData.receive(msg)
      } else {
        // Sync message
        this.#log(`receiving sync message from ${msg.senderId}`)
        await synchronizer.receiveSyncMessage(msg)
      }
    })

    // We establish a special channel for sync messages
    networkSubsystem.join()

    // EPHEMERAL DATA
    // The ephemeral data subsystem uses the network to send and receive messages that are not
    // persisted to storage, e.g. cursor position, presence, etc.

    const ephemeralData = new EphemeralData()
    this.ephemeralData = ephemeralData

    // Send ephemeral messages to peers
    ephemeralData.on("message", message => {
      this.#log(`sending ephemeral message`)
      networkSubsystem.send(message)
    })
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
}

export type SharePolicy = (
  peerId: PeerId,
  documentId?: DocumentId
) => Promise<boolean>
