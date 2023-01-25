import debug from "debug"
import EventEmitter from "eventemitter3"
import { Mixin } from "ts-mixer"

import { DocCollection } from "./DocCollection.js"
import { EphemeralData } from "./EphemeralData.js"
import { NetworkAdapter } from "./network/NetworkAdapter.js"
import {
  NetworkSubsystem,
  NetworkSubsystemEvents,
} from "./network/NetworkSubsystem.js"
import { StorageAdapter } from "./storage/StorageAdapter.js"
import { StorageSubsystem } from "./storage/StorageSubsystem.js"
import { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"
import { ChannelId, PeerId } from "./types.js"

const SYNC_CHANNEL = "sync_channel" as ChannelId

/** A Repo is a DocCollection plus networking, syncing, and storage capabilities. */
export class Repo extends Mixin(
  DocCollection,
  // repo re-emits the events from the network subsystem
  EventEmitter<NetworkSubsystemEvents>
) {
  private log: debug.Debugger

  ephemeralData: EphemeralData

  constructor({
    peerId,
    storage: storageAdapter,
    network: networkAdapters = [],
    sharePolicy = GENEROUS_SHARE_POLICY,
  }: RepoConfig) {
    super()

    this.log = debug(`ar:repo:${peerId}`)

    // The storage subsystem has access to some form of persistence, and deals with save and loading documents.
    const storage = storageAdapter ? new StorageSubsystem(storageAdapter) : null

    // The network subsystem deals with sending and receiving messages to and from peers.
    const network = new NetworkSubsystem(networkAdapters, peerId)

    network.on("peer", payload => {
      const { peerId } = payload

      this.log("peer connected", { peerId })
      const generousPolicy = sharePolicy(peerId)
      synchronizer.addPeer(peerId, generousPolicy)

      this.emit("peer", payload)
    })

    network.on("peer-disconnected", payload => {
      const { peerId } = payload
      synchronizer.removePeer(peerId)
      this.emit("peer-disconnected", payload)
    })

    network.on("message", payload => {
      const { senderId, channelId, message } = payload
      // HACK: ephemeral messages go through channels starting with "m/"
      if (channelId.startsWith("m/")) {
        // process ephemeral message
        this.log(`receiving ephemeral message from ${senderId}`)
        ephemeralData.receive(senderId, channelId, message)
      } else {
        // process sync message
        this.log(`receiving sync message from ${senderId}`)
        synchronizer.receiveSyncMessage(senderId, channelId, message)
      }
      this.emit("message", payload)
    })

    // We establish a special channel for sync messages
    network.join(SYNC_CHANNEL)

    // The synchronizer uses the network subsystem to keep documents in sync with peers.
    const synchronizer = new CollectionSynchronizer(this)

    synchronizer.on(
      "message",
      ({ targetId, channelId, message, broadcast }) => {
        this.log(`sending sync message to ${targetId}`)
        network.sendMessage(targetId, channelId, message, broadcast)
      }
    )

    // The ephemeral data subsystem uses the network to send and receive messages that are not
    // persisted to storage, e.g. cursor position, presence, etc.
    const ephemeralData = new EphemeralData()
    this.ephemeralData = ephemeralData

    ephemeralData.on(
      "message",
      ({ targetId, channelId, message, broadcast }) => {
        this.log(`sending ephemeral message to ${targetId}`)
        network.sendMessage(targetId, channelId, message, broadcast)
      }
    )

    /**
     * The `document` event is fired by the DocCollection any time we create a new document or look
     * up a document by ID. We listen for it in order to wire up storage and network
     * synchronization.
     */
    this.on("document", async ({ handle }) => {
      if (!storage) {
        // if we don't have any kind of storage, we will always wait for the document to come in from a peer. So much for "local-first"
        handle.waitForSync()
      } else {
        // storage listens for changes and saves them
        handle.on("change", ({ handle }) =>
          storage.save(handle.documentId, handle.doc)
        )

        const binary = await storage.loadBinary(handle.documentId)
        if (binary.byteLength > 0) {
          handle.loadIncremental(binary)
        } else {
          handle.waitForSync()
        }
      }

      // register the document with the synchronizer
      synchronizer.addDocument(handle.documentId)
    })
  }
}

export interface RepoConfig {
  /** Our unique identifier */
  peerId?: PeerId

  // Q: Why is this optional? In what scenario would a local-first repo not have local storage?

  /** A storage adapter can be provided, or not */
  storage?: StorageAdapter

  /** One or more network adapters can be provided */
  network?: NetworkAdapter[]

  /**
   * Normal peers typically share generously with everyone (meaning we sync all our documents with
   * all peers). A server only syncs documents that a peer explicitly requests by ID.
   */
  sharePolicy?: (peerId: PeerId) => boolean
}

/** By default, we share generously with all peers. */
const GENEROUS_SHARE_POLICY = () => true
