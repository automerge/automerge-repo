import debug from "debug"
import { DocHandle } from "../DocHandle.js"
import { parseAutomergeUrl } from "../AutomergeUrl.js"
import { Repo } from "../Repo.js"
import { DocMessage } from "../network/messages.js"
import { AutomergeUrl, DocumentId, PeerId } from "../types.js"
import { DocSynchronizer } from "./DocSynchronizer.js"
import { Synchronizer } from "./Synchronizer.js"

const log = debug("automerge-repo:collectionsync")

/** A CollectionSynchronizer is responsible for synchronizing a DocCollection with peers. */
export class CollectionSynchronizer extends Synchronizer {
  /** The set of peers we are connected with */
  #peers: Set<PeerId> = new Set()

  /** A map of documentIds to their synchronizers */
  /** @hidden */
  docSynchronizers: Record<DocumentId, DocSynchronizer> = {}

  /** Used to determine if the document is know to the Collection and a synchronizer exists or is being set up */
  #docSetUp: Record<DocumentId, boolean> = {}

  #denylist: DocumentId[]

  constructor(private repo: Repo, denylist: AutomergeUrl[] = []) {
    super()
    this.#denylist = denylist.map(url => parseAutomergeUrl(url).documentId)
  }

  /** Returns a synchronizer for the given document, creating one if it doesn't already exist.  */
  #fetchDocSynchronizer(handle: DocHandle<unknown>) {
    if (!this.docSynchronizers[handle.documentId]) {
      this.docSynchronizers[handle.documentId] =
        this.#initDocSynchronizer(handle)
    }
    return this.docSynchronizers[handle.documentId]
  }

  /** Creates a new docSynchronizer and sets it up to propagate messages */
  #initDocSynchronizer(handle: DocHandle<unknown>): DocSynchronizer {
    const docSynchronizer = new DocSynchronizer({
      handle,
      peerId: this.repo.networkSubsystem.peerId,
      onLoadSyncState: async peerId => {
        if (!this.repo.storageSubsystem) {
          return
        }

        const { storageId, isEphemeral } =
          this.repo.peerMetadataByPeerId[peerId] || {}
        if (!storageId || isEphemeral) {
          return
        }

        return this.repo.storageSubsystem.loadSyncState(
          handle.documentId,
          storageId
        )
      },
    })
    docSynchronizer.on("message", event => this.emit("message", event))
    docSynchronizer.on("open-doc", event => this.emit("open-doc", event))
    docSynchronizer.on("sync-state", event => this.emit("sync-state", event))
    docSynchronizer.on("metrics", event => this.emit("metrics", event))
    return docSynchronizer
  }

  /** returns an array of peerIds that we share this document generously with */
  async #documentGenerousPeers(documentId: DocumentId): Promise<PeerId[]> {
    const peers = Array.from(this.#peers)
    const generousPeers: PeerId[] = []
    for (const peerId of peers) {
      const okToShare = await this.repo.sharePolicy(peerId, documentId)
      if (okToShare) generousPeers.push(peerId)
    }
    return generousPeers
  }

  // PUBLIC

  /**
   * When we receive a sync message for a document we haven't got in memory, we
   * register it with the repo and start synchronizing
   */
  async receiveMessage(message: DocMessage) {
    log(
      `onSyncMessage: ${message.senderId}, ${message.documentId}, ${
        "data" in message ? message.data.byteLength + "bytes" : ""
      }`
    )

    const documentId = message.documentId
    if (!documentId) {
      throw new Error("received a message with an invalid documentId")
    }

    if (this.#denylist.includes(documentId)) {
      this.emit("metrics", {
        type: "doc-denied",
        documentId,
      })
      this.emit("message", {
        type: "doc-unavailable",
        documentId,
        targetId: message.senderId,
      })
      return
    }

    this.#docSetUp[documentId] = true

    const handle = await this.repo.find(documentId, {
      allowableStates: ["ready", "requesting"],
    })
    const docSynchronizer = this.#fetchDocSynchronizer(handle)

    docSynchronizer.receiveMessage(message)

    // Initiate sync with any new peers
    const peers = await this.#documentGenerousPeers(documentId)
    void docSynchronizer.beginSync(
      peers.filter(peerId => !docSynchronizer.hasPeer(peerId))
    )
  }

  /**
   * Starts synchronizing the given document with all peers that we share it generously with.
   */
  addDocument(handle: DocHandle<unknown>) {
    // HACK: this is a hack to prevent us from adding the same document twice
    if (this.#docSetUp[handle.documentId]) {
      return
    }
    const docSynchronizer = this.#fetchDocSynchronizer(handle)
    void this.#documentGenerousPeers(handle.documentId).then(peers => {
      void docSynchronizer.beginSync(peers)
    })
  }

  // TODO: implement this
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  removeDocument(documentId: DocumentId) {
    throw new Error("not implemented")
  }

  /** Adds a peer and maybe starts synchronizing with them */
  addPeer(peerId: PeerId) {
    log(`adding ${peerId} & synchronizing with them`)

    if (this.#peers.has(peerId)) {
      return
    }

    this.#peers.add(peerId)
    for (const docSynchronizer of Object.values(this.docSynchronizers)) {
      const { documentId } = docSynchronizer
      void this.repo.sharePolicy(peerId, documentId).then(okToShare => {
        if (okToShare) void docSynchronizer.beginSync([peerId])
      })
    }
  }

  /** Removes a peer and stops synchronizing with them */
  removePeer(peerId: PeerId) {
    log(`removing peer ${peerId}`)
    this.#peers.delete(peerId)

    for (const docSynchronizer of Object.values(this.docSynchronizers)) {
      docSynchronizer.endSync(peerId)
    }
  }

  /** Returns a list of all connected peer ids */
  get peers(): PeerId[] {
    return Array.from(this.#peers)
  }

  metrics(): {
    [key: string]: {
      peers: PeerId[]
      size: { numOps: number; numChanges: number }
    }
  } {
    return Object.fromEntries(
      Object.entries(this.docSynchronizers).map(
        ([documentId, synchronizer]) => {
          return [documentId, synchronizer.metrics()]
        }
      )
    )
  }
}
