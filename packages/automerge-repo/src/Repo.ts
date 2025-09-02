import { next as Automerge } from "@automerge/automerge/slim"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import {
  encodeHeads,
  generateAutomergeUrl,
  interpretAsDocumentId,
  isValidAutomergeUrl,
  parseAutomergeUrl,
} from "./AutomergeUrl.js"
import {
  DELETED,
  DocHandle,
  DocHandleEncodedChangePayload,
  READY,
  UNAVAILABLE,
  UNLOADED,
} from "./DocHandle.js"
import { RemoteHeadsSubscriptions } from "./RemoteHeadsSubscriptions.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { throttle } from "./helpers/throttle.js"
import {
  NetworkAdapterInterface,
  type PeerMetadata,
} from "./network/NetworkAdapterInterface.js"
import { NetworkSubsystem } from "./network/NetworkSubsystem.js"
import { DocMessage, RepoMessage } from "./network/messages.js"
import { StorageAdapterInterface } from "./storage/StorageAdapterInterface.js"
import { StorageSubsystem } from "./storage/StorageSubsystem.js"
import { StorageId } from "./storage/types.js"
import type {
  AnyDocumentId,
  AutomergeUrl,
  DocumentId,
  PeerId,
  UrlHeads,
} from "./types.js"
import { abortable, AbortOptions } from "./helpers/abortable.js"
import { FindProgress } from "./FindProgress.js"
import {
  DocumentPhasor,
  PhaseName,
  type DocEvent,
  type Effects as DocEffects,
} from "./DocumentPhasor.js"

export type FindProgressWithMethods<T> = FindProgress<T> & {
  untilReady: (allowableStates: string[]) => Promise<DocHandle<T>>
  peek: () => FindProgress<T>
  subscribe: (callback: (progress: FindProgress<T>) => void) => () => void
}

function randomPeerId() {
  return ("peer-" + Math.random().toString(36).slice(4)) as PeerId
}

/** A Repo is a collection of documents with networking, syncing, and storage capabilities. */
/** The `Repo` is the main entry point of this library
 *
 * @remarks
 * To construct a `Repo` you will need an {@link StorageAdapter} and one or
 * more {@link NetworkAdapter}s. Once you have a `Repo` you can use it to
 * obtain {@link DocHandle}s.
 */
export class Repo extends EventEmitter<RepoEvents> {
  #log: debug.Debugger

  /** @hidden */
  networkSubsystem: NetworkSubsystem
  /** @hidden */
  storageSubsystem?: StorageSubsystem

  /** @hidden */
  #saveDebounceRate: number

  /** @hidden */
  #saveFn: (payload: { docId: DocumentId }) => void

  /** By default, we share generously with all peers. */
  /** @hidden */
  sharePolicy: SharePolicy = async () => true

  /** maps peer id to to persistence information (storageId, isEphemeral), access by collection synchronizer  */
  /** @hidden */
  peerMetadataByPeerId: Record<PeerId, PeerMetadata> = {}

  #remoteHeadsSubscriptions = new RemoteHeadsSubscriptions()
  #remoteHeadsGossipingEnabled = false
  #saveFns: Record<DocumentId, (payload: { docId: DocumentId }) => void> = {}
  #documents: Map<DocumentId, DocState<any>> = new Map()
  #connectedPeers: Map<PeerId, PeerMetadata> = new Map()
  #peerId: PeerId
  #denylist: Set<DocumentId>

  constructor({
    storage,
    network = [],
    peerId = randomPeerId(),
    sharePolicy,
    isEphemeral = storage === undefined,
    enableRemoteHeadsGossiping = false,
    denylist = [],
    saveDebounceRate = 100,
  }: RepoConfig = {}) {
    super()
    this.#remoteHeadsGossipingEnabled = enableRemoteHeadsGossiping
    this.#log = debug(`automerge-repo:repo(${peerId})`)
    this.sharePolicy = sharePolicy ?? this.sharePolicy
    this.#peerId = peerId
    this.#denylist = new Set(
      denylist.map(url => parseAutomergeUrl(url).documentId)
    )

    this.on("delete-document", ({ documentId }) => {
      if (storageSubsystem) {
        storageSubsystem.removeDoc(documentId).catch(err => {
          this.#log("error deleting document", { documentId, err })
        })
      }
    })

    // STORAGE
    // The storage subsystem has access to some form of persistence, and deals with save and loading documents.
    const storageSubsystem = storage ? new StorageSubsystem(storage) : undefined
    if (storageSubsystem) {
      storageSubsystem.on("document-loaded", event =>
        this.emit("doc-metrics", { type: "doc-loaded", ...event })
      )
    }

    this.storageSubsystem = storageSubsystem

    this.#saveDebounceRate = saveDebounceRate

    if (this.storageSubsystem) {
      // Save no more often than saveDebounceRate.
      this.#saveFn = ({ docId }: { docId: DocumentId }) => {
        let docState = this.#documents.get(docId)
        if (!docState) return
        let fn = this.#saveFns[docId]
        if (!fn) {
          fn = throttle(() => {
            void this.storageSubsystem!.saveDoc(docId, docState.phasor.doc())
          }, this.#saveDebounceRate)
          this.#saveFns[docId] = fn
        }
        fn({ docId })
      }
    } else {
      this.#saveFn = () => {}
    }

    // NETWORK
    // The network subsystem deals with sending and receiving messages to and from peers.

    const myPeerMetadata: Promise<PeerMetadata> = (async () => ({
      storageId: await storageSubsystem?.id(),
      isEphemeral,
    }))()

    const networkSubsystem = new NetworkSubsystem(
      network,
      peerId,
      myPeerMetadata
    )
    this.networkSubsystem = networkSubsystem

    networkSubsystem.whenReady().then(() => {
      for (const docId of this.#documents.keys()) {
        this.#processDocEvent(docId, { type: "network_ready" })
      }
    })

    // When we get a new peer, register it with the synchronizer
    networkSubsystem.on("peer", async ({ peerId, peerMetadata }) => {
      this.#connectedPeers.set(peerId, peerMetadata)
      this.#log("peer connected", { peerId })

      if (peerMetadata) {
        this.peerMetadataByPeerId[peerId] = { ...peerMetadata }
      }

      this.sharePolicy(peerId)
        .then(shouldShare => {
          if (shouldShare && this.#remoteHeadsGossipingEnabled) {
            this.#remoteHeadsSubscriptions.addGenerousPeer(peerId)
          }
        })
        .catch(err => {
          console.log("error in share policy", { err })
        })

      for (const docId of this.#documents.keys()) {
        this.#processDocEvent(docId, { type: "peer_added", peerId })
        this.#loadPeerForDoc(docId, peerId, peerMetadata)
      }
    })

    // When a peer disconnects, remove it from the synchronizer
    networkSubsystem.on("peer-disconnected", ({ peerId }) => {
      this.#connectedPeers.delete(peerId)
      this.#remoteHeadsSubscriptions.removePeer(peerId)
      for (const [docId, docState] of this.#documents.entries()) {
        this.#processDocEvent(docId, { type: "peer_removed", peerId })
      }
    })

    // Handle incoming messages
    networkSubsystem.on("message", async msg => {
      this.#receiveMessage(msg)
    })

    if (this.#remoteHeadsGossipingEnabled) {
      this.#remoteHeadsSubscriptions.on("notify-remote-heads", message => {
        this.networkSubsystem.send({
          type: "remote-heads-changed",
          targetId: message.targetId,
          documentId: message.documentId,
          newHeads: {
            [message.storageId]: {
              heads: message.heads,
              timestamp: message.timestamp,
            },
          },
        })
      })

      this.#remoteHeadsSubscriptions.on("change-remote-subs", message => {
        this.#log("change-remote-subs", message)
        for (const peer of message.peers) {
          this.networkSubsystem.send({
            type: "remote-subscription-change",
            targetId: peer,
            add: message.add,
            remove: message.remove,
          })
        }
      })

      this.#remoteHeadsSubscriptions.on(
        "remote-heads-changed",
        ({ documentId, storageId, remoteHeads, timestamp }) => {
          const docState = this.#documents.get(documentId)
          if (!docState) return
          docState.rootHandle.setSyncInfo(storageId, {
            lastHeads: remoteHeads,
            lastSyncTimestamp: timestamp,
          })
          for (const view of docState.viewHandles) {
            view.handle.setSyncInfo(storageId, {
              lastHeads: remoteHeads,
              lastSyncTimestamp: timestamp,
            })
          }
        }
      )
    }
  }

  get peerId(): PeerId {
    return this.#peerId
  }

  #loadPeerForDoc(
    docId: DocumentId,
    peerId: PeerId,
    peerMetadata: PeerMetadata
  ) {
    this.sharePolicy(peerId, docId).then(shouldShare => {
      this.#processDocEvent(docId, {
        type: "peer_share_policy_loaded",
        peerId,
        shouldShare,
      })
    })
    let syncStatePromise
    // Note that somehow `peerMetadata` can be undefined here if the websocket adapter
    // is used. This is probably due to bad message validation in the websocket adapter
    if (peerMetadata?.storageId != null && this.storageSubsystem != null) {
      syncStatePromise = this.storageSubsystem
        .loadSyncState(docId, peerMetadata.storageId)
        .then(syncState => {
          if (syncState == null) syncState = Automerge.initSyncState()
          return syncState
        })
    } else {
      syncStatePromise = Promise.resolve(Automerge.initSyncState())
    }
    syncStatePromise.then(syncState => {
      this.#processDocEvent(docId, {
        type: "peer_sync_state_loaded",
        peerId,
        syncState,
      })
    })
  }

  #spawnDoc<T>(
    docId: DocumentId,
    doc: Automerge.Doc<T> | undefined
  ): DocState<T> {
    if (this.#denylist.has(docId)) {
      throw new Error("attempting to spawn a denied document")
    }
    if (this.#documents.has(docId)) {
      throw new Error(`document phasor for ${docId} already exists`)
    }
    const phasor = new DocumentPhasor<T>({
      ourPeerId: this.#peerId,
      documentId: docId,
      initialState: doc,
      networkReady: this.networkSubsystem.isReady(),
    })
    const rootHandle = new DocHandle<T>(
      docId,
      changeFn => {
        const docState = this.#documents.get(docId) as DocState<T> | undefined
        if (!docState)
          throw new Error(`Document not found for documentId ${docId}`)
        const { result, effects } = docState.phasor.localChange(changeFn)
        this.#handleDocEffects(docId, effects)
        return result
      },
      () => phasor.doc()
    )
    rootHandle.on("ephemeral-message-outbound", message => {
      this.#processDocEvent(docId, {
        type: "outbound_ephemeral_message",
        message: message.data,
      })
    })
    const docState = {
      phasor,
      rootHandle,
      rootProgress: {
        state: "loading" as const,
        progress: 0,
        handle: rootHandle,
      },
      viewHandles: [],
      subscribers: new Set<() => void>(),
    }
    this.#documents.set(docId, docState)
    rootHandle.setState(phasor.phase())

    for (const [peerId, peerMetadata] of this.#connectedPeers.entries()) {
      const effects = phasor.handleEvent({ type: "peer_added", peerId })
      this.#handleDocEffects(docId, effects)
      this.#loadPeerForDoc(docId, peerId, peerMetadata)
    }
    this.#handleDocEffects(docId, phasor.tick())
    return docState
  }

  #processDocEvent<T>(docId: DocumentId, event: DocEvent<T>) {
    const docState = this.#documents.get(docId)
    if (docState == null) throw new Error(`unknown doc phasor: ${docId}`)
    const effects = docState.phasor.handleEvent(event)
    this.#handleDocEffects(docId, effects)
  }

  #handleDocEffects<T>(docId: DocumentId, effects: DocEffects<T>) {
    const docState = this.#documents.get(docId)
    if (docState == null) throw new Error(`unknown doc phasor: ${docId}`)
    if (effects.stateChange) {
      docState.rootHandle.setState(effects.stateChange.after)
      docState.rootProgress = phaseToProgress(
        effects.stateChange.after,
        docState.rootHandle
      )
      notify(docState)
    }
    if (effects.docChanged != null) {
      this.#saveFn({ docId })
      docState.rootHandle.emit("heads-changed", {
        handle: docState.rootHandle,
        doc: effects.docChanged.docAfter,
      })
      if (effects.docChanged.diff.length > 0) {
        docState.rootHandle.emit("change", {
          handle: docState.rootHandle,
          doc: effects.docChanged.docAfter,
          patches: effects.docChanged.diff,
          // TODO: pass along the source (load/change/network)
          patchInfo: {
            before: effects.docChanged.docBefore,
            after: effects.docChanged.docAfter,
            source: "change",
          },
        })
      }
    }
    for (const msg of effects.newEphemeralMessages) {
      docState.rootHandle.emit("ephemeral-message", {
        handle: docState.rootHandle,
        senderId: msg.senderId,
        message: msg.content,
      })
    }
    if (effects.beginLoad) {
      this.#log("dispatching load for document ", docId)
      if (this.storageSubsystem) {
        this.storageSubsystem.loadDocData(docId).then(data => {
          this.#processDocEvent(docId, { type: "load_complete", data })
        })
      } else {
        this.#processDocEvent(docId, { type: "load_complete", data: null })
      }
    }
    for (const msg of effects.outboundMessages) {
      this.networkSubsystem.send(msg)
    }
    for (const msg of effects.forwardedEphemeralMessages) {
      this.networkSubsystem.send(msg)
    }
    for (const [peerId, syncState] of effects.newSyncStates.entries()) {
      const { storageId } = this.peerMetadataByPeerId[peerId]

      if (storageId != null) {
        this.#saveSyncState({ peerId, documentId: docId, syncState })
      }
    }

    for (const [peerId, { after }] of effects.remoteHeadsChanged.entries()) {
      const { storageId } = this.peerMetadataByPeerId[peerId]

      if (storageId != null) {
        docState.rootHandle.setSyncInfo(storageId, {
          lastHeads: encodeHeads(after),
          lastSyncTimestamp: Date.now(),
        })
      }
      if (storageId && this.#remoteHeadsGossipingEnabled) {
        this.#log("notifying of remote heads change")
        this.#remoteHeadsSubscriptions.handleImmediateRemoteHeadsChanged(
          docId,
          storageId,
          encodeHeads(after)
        )
      }
    }
    if (this.#remoteHeadsGossipingEnabled) {
      for (const peerId of effects.newActivePeers) {
        this.#remoteHeadsSubscriptions.subscribePeerToDoc(peerId, docId)
      }
    }
  }

  #receiveMessage(message: RepoMessage) {
    this.#log("received message ", message)
    switch (message.type) {
      case "remote-subscription-change":
        if (this.#remoteHeadsGossipingEnabled) {
          this.#remoteHeadsSubscriptions.handleControlMessage(message)
        }
        break
      case "remote-heads-changed":
        if (this.#remoteHeadsGossipingEnabled) {
          this.#remoteHeadsSubscriptions.handleRemoteHeads(message)
        }
        break
      case "sync":
      case "request":
      case "ephemeral":
      case "doc-unavailable":
        if (this.#denylist.has(message.documentId)) {
          if (message.type === "request") {
            this.networkSubsystem.send({
              targetId: message.senderId,
              type: "doc-unavailable",
              documentId: message.documentId,
            })
          }
          return
        }
        let docState = this.#documents.get(message.documentId)
        if (!docState) {
          this.#spawnDoc(message.documentId, undefined)
        }
        this.#processDocEvent(message.documentId, {
          type: "sync_message_received",
          peerId: message.senderId,
          message: message,
        })
    }
  }

  #throttledSaveSyncStateHandlers: Record<
    StorageId,
    (payload: SyncStatePayload) => void
  > = {}

  /** saves sync state throttled per storage id, if a peer doesn't have a storage id it's sync state is not persisted */
  #saveSyncState(payload: SyncStatePayload) {
    if (!this.storageSubsystem) {
      return
    }

    const { storageId, isEphemeral } =
      this.peerMetadataByPeerId[payload.peerId] || {}

    if (!storageId || isEphemeral) {
      return
    }

    let handler = this.#throttledSaveSyncStateHandlers[storageId]
    if (!handler) {
      handler = this.#throttledSaveSyncStateHandlers[storageId] = throttle(
        ({ documentId, syncState }: SyncStatePayload) => {
          void this.storageSubsystem!.saveSyncState(
            documentId,
            storageId,
            syncState
          )
        },
        this.#saveDebounceRate
      )
    }

    handler(payload)
  }

  /** Returns all the handles we have cached. */
  get handles(): Record<DocumentId, DocHandle<any>> {
    const result: Record<DocumentId, DocHandle<any>> = {}
    for (const [docId, docState] of this.#documents.entries()) {
      result[docId] = docState.rootHandle
    }
    return result
  }

  /** Returns a list of all connected peer ids */
  get peers(): PeerId[] {
    return Array.from(this.#connectedPeers.keys())
  }

  getStorageIdOfPeer(peerId: PeerId): StorageId | undefined {
    return this.peerMetadataByPeerId[peerId]?.storageId
  }

  /**
   * Creates a new document and returns a handle to it. The initial value of the document is an
   * empty object `{}` unless an initial value is provided. Its documentId is generated by the
   * system. we emit a `document` event to advertise interest in the document.
   */
  create<T>(initialValue?: T): DocHandle<T> {
    // Generate a new UUID and store it in the buffer
    const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
    let doc: Automerge.Doc<T>
    if (initialValue) {
      doc = Automerge.from(initialValue)
    } else {
      doc = Automerge.emptyChange(Automerge.init())
    }
    const docState = this.#spawnDoc(documentId, doc)
    this.#saveFn({ docId: documentId })

    return docState.rootHandle
  }

  /** Create a new DocHandle by cloning the history of an existing DocHandle.
   *
   * @param clonedHandle - The handle to clone
   *
   * @remarks This is a wrapper around the `clone` function in the Automerge library.
   * The new `DocHandle` will have a new URL but will share history with the original,
   * which means that changes made to the cloned handle can be sensibly merged back
   * into the original.
   *
   * Any peers this `Repo` is connected to for whom `sharePolicy` returns `true` will
   * be notified of the newly created DocHandle.
   *
   */
  clone<T>(clonedHandle: DocHandle<T>): DocHandle<T> {
    if (!clonedHandle.isReady()) {
      throw new Error(
        `Cloned handle is not yet in ready state.
        (Try await handle.whenReady() first.)`
      )
    }
    return this.import(Automerge.save(clonedHandle.doc()))
  }

  findWithProgress<T>(
    id: AnyDocumentId,
    options: AbortOptions = {}
  ): FindProgressWithMethods<T> {
    const { signal } = options
    const { documentId, heads } = isValidAutomergeUrl(id)
      ? parseAutomergeUrl(id)
      : { documentId: interpretAsDocumentId(id), heads: undefined }

    if (this.#denylist.has(documentId)) {
      throw new Error(`Document ${id} is unavailable`)
    }

    let docState = this.#documents.get(documentId)
    if (docState == null) {
      docState = this.#spawnDoc(documentId, undefined)
    }

    if (docState.phasor.phase() == "unavailable") {
      this.#processDocEvent(documentId, { type: "reload" })
    }
    return findProgress(docState, heads)
  }

  async find<T>(
    id: AnyDocumentId,
    options: RepoFindOptions & AbortOptions = {}
  ): Promise<DocHandle<T>> {
    const { allowableStates = ["ready"], signal } = options

    // Check if already aborted
    if (signal?.aborted) {
      throw new Error("Operation aborted")
    }

    const progress = this.findWithProgress<T>(id, { signal })

    if (allowableStates.includes(progress.state)) {
      return progress.handle
    }
    if (progress.state === "unavailable") {
      throw new Error(`Document ${id} is unavailable`)
    }

    const findPromise = new Promise<DocHandle<T>>((resolve, reject) => {
      const unsubscribe = progress.subscribe(state => {
        if (allowableStates.includes(state.handle.state)) {
          unsubscribe()
          resolve(state.handle)
        } else if (state.state === "unavailable") {
          unsubscribe()
          reject(new Error(`Document ${id} is unavailable`))
        } else if (state.state === "failed") {
          unsubscribe()
          reject(state.error)
        }
      })
    })
    return Promise.race([
      findPromise,
      abortable(new Promise(() => {}), signal) as Promise<never>,
    ])
  }

  /**
   * Loads a document without waiting for ready state
   */
  async #loadDocument<T>(documentId: DocumentId): Promise<DocHandle<T>> {
    let docState = this.#documents.get(documentId)
    if (!docState) {
      docState = this.#spawnDoc(documentId, undefined)
    }

    return docState.rootHandle
  }

  /**
   * Retrieves a document by id. It gets data from the local system, but also emits a `document`
   * event to advertise interest in the document.
   */
  async findClassic<T>(
    /** The url or documentId of the handle to retrieve */
    id: AnyDocumentId,
    options: RepoFindOptions & AbortOptions = {}
  ): Promise<DocHandle<T>> {
    const documentId = interpretAsDocumentId(id)
    const { allowableStates, signal } = options

    return abortable(
      (async () => {
        const handle = await this.#loadDocument<T>(documentId)
        if (!allowableStates) {
          await handle.whenReady([READY, UNAVAILABLE])
          if (handle.state === UNAVAILABLE && !signal?.aborted) {
            throw new Error(`Document ${id} is unavailable`)
          }
        }
        return handle
      })(),
      signal
    )
  }

  delete(
    /** The url or documentId of the handle to delete */
    id: AnyDocumentId
  ) {
    const documentId = interpretAsDocumentId(id)

    delete this.#saveFns[documentId]

    const docState = this.#documents.get(documentId)
    this.#documents.delete(documentId)

    if (docState) {
      docState.rootHandle.setState("deleted")
      for (const view of docState.viewHandles) {
        view.handle.setState("deleted")
      }
    }

    this.emit("delete-document", { documentId })
  }

  /**
   * Exports a document to a binary format.
   * @param id - The url or documentId of the handle to export
   *
   * @returns Promise<Uint8Array | undefined> - A Promise containing the binary document,
   * or undefined if the document is unavailable.
   */
  async export(id: AnyDocumentId): Promise<Uint8Array | undefined> {
    const documentId = interpretAsDocumentId(id)

    const docState = this.#documents.get(documentId)
    if (!docState) throw new Error("document not found")

    return Automerge.save(docState.phasor.doc())
  }

  /**
   * Imports document binary into the repo.
   * @param binary - The binary to import
   * @param args - Optional argument specifying what document ID to import into,
   *              if at all possible avoid using this, see the remarks below
   *
   * @remarks
   * If no document ID is provided, a new document will be created. When
   * specifying the document ID it is important to ensure that two documents using
   * the same ID share the same history - i.e. don't create a document with the
   * same ID on unrelated processes that have never communicated with each
   * other. If you need to ship around a bunch of documents with their IDs
   * consider using the `automerge-repo-bundles` package which provides a
   * serialization format for documents and IDs and handles the boilerplate of
   * importing and exporting these bundles.
   */
  import<T>(binary: Uint8Array, args?: { docId?: DocumentId }): DocHandle<T> {
    const docId =
      args?.docId || parseAutomergeUrl(generateAutomergeUrl()).documentId
    if (this.#denylist.has(docId)) {
      throw new Error(
        "attempting to import a document which is on the configured denylist"
      )
    }
    const doc = Automerge.load<T>(binary)
    const docState = this.#spawnDoc(docId, doc)
    return docState.rootHandle
  }

  subscribeToRemotes = (remotes: StorageId[]) => {
    if (this.#remoteHeadsGossipingEnabled) {
      this.#log("subscribeToRemotes", { remotes })
      this.#remoteHeadsSubscriptions.subscribeToRemotes(remotes)
    } else {
      this.#log(
        "WARN: subscribeToRemotes called but remote heads gossiping is not enabled"
      )
    }
  }

  storageId = async (): Promise<StorageId | undefined> => {
    if (!this.storageSubsystem) {
      return undefined
    } else {
      return this.storageSubsystem.id()
    }
  }

  /**
   * Writes Documents to a disk.
   * @hidden this API is experimental and may change.
   * @param documents - if provided, only writes the specified documents.
   * @returns Promise<void>
   */
  async flush(documents?: DocumentId[]): Promise<void> {
    if (!this.storageSubsystem) {
      return
    }
    let docStates: DocState<unknown>[] = Array.from(this.#documents.values())
    if (documents) {
      docStates = []
      for (const docId of documents) {
        const docState = this.#documents.get(docId)
        if (docState) {
          docStates.push(docState)
        }
      }
    }
    await Promise.all(
      docStates.map(async docState => {
        return this.storageSubsystem!.saveDoc(
          docState.phasor.documentId,
          docState.phasor.doc()
        )
      })
    )
  }

  /**
   * Removes a DocHandle from the handleCache.
   * @hidden this API is experimental and may change.
   * @param documentId - documentId of the DocHandle to remove from handleCache, if present in cache.
   * @returns Promise<void>
   */
  async removeFromCache(documentId: DocumentId) {
    const docState = this.#documents.get(documentId)
    if (!docState) {
      this.#log(
        `WARN: removeFromCache called but handle not found for documentId: ${documentId}`
      )
      return
    }

    delete this.#saveFns[documentId]
    this.#documents.delete(documentId)
  }

  shutdown(): Promise<void> {
    this.networkSubsystem.adapters.forEach(adapter => {
      adapter.disconnect()
    })
    return this.flush()
  }

  metrics(): { documents: { [key: string]: any } } {
    return { documents: {} }
    // return { documents: this.synchronizer.metrics() }
  }

  peersForDoc(docId: DocumentId): PeerId[] {
    const docState = this.#documents.get(docId)
    if (!docState) return []
    return docState.phasor.activePeers()
  }

  activeDocs(): Set<DocumentId> {
    return new Set(this.#documents.keys())
  }
}

export interface RepoConfig {
  /** Our unique identifier */
  peerId?: PeerId

  /** Indicates whether other peers should persist the sync state of this peer.
   * Sync state is only persisted for non-ephemeral peers */
  isEphemeral?: boolean

  /** A storage adapter can be provided, or not */
  storage?: StorageAdapterInterface

  /** A list of network adapters (more can be added at runtime). */
  network?: NetworkAdapterInterface[]

  /**
   * Normal peers typically share generously with everyone (meaning we sync all our documents with
   * all peers). A server only syncs documents that a peer explicitly requests by ID.
   */
  sharePolicy?: SharePolicy

  /**
   * Whether to enable the experimental remote heads gossiping feature
   */
  enableRemoteHeadsGossiping?: boolean

  /**
   * A list of automerge URLs which should never be loaded regardless of what
   * messages are received or what the share policy is. This is useful to avoid
   * loading documents that are known to be too resource intensive.
   */
  denylist?: AutomergeUrl[]

  /**
   * The debounce rate in milliseconds for saving documents. Defaults to 100ms.
   */
  saveDebounceRate?: number
}

/** A function that determines whether we should share a document with a peer
 *
 * @remarks
 * This function is called by the {@link Repo} every time a new document is created
 * or discovered (such as when another peer starts syncing with us). If this
 * function returns `true` then the {@link Repo} will begin sharing the new
 * document with the peer given by `peerId`.
 * */
export type SharePolicy = (
  peerId: PeerId,
  documentId?: DocumentId
) => Promise<boolean>

// events & payloads
export interface RepoEvents {
  /** A new document was created or discovered */
  document: (arg: DocumentPayload) => void
  /** A document was deleted */
  "delete-document": (arg: DeleteDocumentPayload) => void
  /** A document was marked as unavailable (we don't have it and none of our peers have it) */
  "unavailable-document": (arg: DeleteDocumentPayload) => void
  "doc-metrics": (arg: DocMetrics) => void
}

export interface RepoFindOptions {
  allowableStates?: string[]
}

export interface DocumentPayload {
  handle: DocHandle<any>
}

export interface DeleteDocumentPayload {
  documentId: DocumentId
}

export type DocMetrics =
  | DocSyncMetrics
  | {
      type: "doc-loaded"
      documentId: DocumentId
      durationMillis: number
      numOps: number
      numChanges: number
    }
  | {
      type: "doc-denied"
      documentId: DocumentId
    }

/** Notify the repo that the sync state has changed  */
export interface SyncStatePayload {
  peerId: PeerId
  documentId: DocumentId
  syncState: Automerge.SyncState
}

export type DocSyncMetrics =
  | {
      type: "receive-sync-message"
      documentId: DocumentId
      durationMillis: number
      numOps: number
      numChanges: number
    }
  | {
      type: "doc-denied"
      documentId: DocumentId
    }

type DocState<T> = {
  rootHandle: DocHandle<T>
  rootProgress: FindProgress<T>
  viewHandles: {
    heads: Automerge.Heads
    handle: DocHandle<T>
    progress: FindProgress<T>
    subscribers: Set<(progress: FindProgress<T>) => void>
  }[]
  phasor: DocumentPhasor<T>
  subscribers: Set<(progress: FindProgress<T>) => void>
}

function findProgress<T>(
  docState: DocState<T>,
  atHeads?: UrlHeads
): FindProgressWithMethods<T> {
  let subscribers
  let progress
  let peek
  let handle
  if (!atHeads) {
    subscribers = docState.subscribers
    progress = docState.rootProgress
    peek = () => docState.rootProgress
    handle = docState.rootHandle
  } else {
    let view = docState.viewHandles.find(handle => handle.heads === atHeads)
    if (!view) {
      const viewHandle = docState.rootHandle.view(atHeads)
      view = {
        heads: atHeads,
        handle: viewHandle,
        progress: {
          ...docState.rootProgress,
          handle: viewHandle,
        },
        subscribers: new Set<(progress: FindProgress<T>) => void>(),
      }
      docState.viewHandles.push(view)
    }
    handle = view.handle
    peek = () => view.progress
    subscribers = view.subscribers
    progress = view.progress
  }

  const subscribe: (
    callback: (progress: FindProgress<T>) => void
  ) => () => void = callback => {
    subscribers.add(callback)
    return () => {
      docState.subscribers.delete(callback)
    }
  }

  return {
    ...progress,
    subscribe,
    peek,
    untilReady: (allowableStates: string[]) =>
      new Promise<DocHandle<T>>(resolve => {
        const unsubscribe = subscribe(progress => {
          if (allowableStates.includes(progress.state)) {
            unsubscribe()
            resolve(handle)
          }
        })
      }),
  }
}

function notify<T>(docState: DocState<T>) {
  docState.subscribers.forEach(callback => callback(docState.rootProgress))
}

function phaseToProgress<T>(
  phase: PhaseName,
  handle: DocHandle<T>
): FindProgress<T> {
  switch (phase) {
    case "loading": {
      return {
        state: "loading" as const,
        progress: 50,
        handle,
      }
      break
    }
    case "requesting": {
      return {
        state: "loading" as const,
        progress: 75,
        handle,
      }
      break
    }
    case "ready": {
      return {
        state: "ready" as const,
        handle,
      }
      break
    }
    case "unavailable": {
      return {
        state: "unavailable" as const,
        handle,
      }
      break
    }
    default:
      const exhaustivenessCheck: never = phase
      throw new Error(`Unhandled phase: ${exhaustivenessCheck}`)
  }
}
