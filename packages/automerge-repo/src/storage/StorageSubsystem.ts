import * as A from "@automerge/automerge/slim/next"
import debug from "debug"
import { headsAreSame } from "../helpers/headsAreSame.js"
import { mergeArrays } from "../helpers/mergeArrays.js"
import { type DocumentId } from "../types.js"
import { StorageAdapterInterface } from "./StorageAdapterInterface.js"
import { ChunkInfo, StorageKey, StorageId } from "./types.js"
import { keyHash, headsHash } from "./keyHash.js"
import { chunkTypeFromKey } from "./chunkTypeFromKey.js"
import * as Uuid from "uuid"
import { EventEmitter } from "eventemitter3"

type StorageSubsystemEvents = {
  "document-loaded": (arg: {
    documentId: DocumentId
    durationMillis: number
    numOps: number
    numChanges: number
  }) => void
}

/**
 * The storage subsystem is responsible for saving and loading Automerge documents to and from
 * storage adapter. It also provides a generic key/value storage interface for other uses.
 */
export class StorageSubsystem extends EventEmitter<StorageSubsystemEvents> {
  /** The storage adapter to use for saving and loading documents */
  #storageAdapter: StorageAdapterInterface

  /** Record of the latest heads we've loaded or saved for each document  */
  #storedHeads: Map<DocumentId, A.Heads> = new Map()

  #log = debug(`automerge-repo:storage-subsystem`)

  #beelay: A.beelay.Beelay

  constructor(
    beelay: A.beelay.Beelay,
    storageAdapter: StorageAdapterInterface
  ) {
    super()
    this.#storageAdapter = storageAdapter
    this.#beelay = beelay
  }

  async id(): Promise<StorageId> {
    const storedId = await this.#storageAdapter.load(["storage-adapter-id"])

    let id: StorageId
    if (storedId) {
      id = new TextDecoder().decode(storedId) as StorageId
    } else {
      id = Uuid.v4() as StorageId
      await this.#storageAdapter.save(
        ["storage-adapter-id"],
        new TextEncoder().encode(id)
      )
    }

    return id
  }

  // ARBITRARY KEY/VALUE STORAGE

  // The `load`, `save`, and `remove` methods are for generic key/value storage, as opposed to
  // Automerge documents. For example, they're used by the LocalFirstAuthProvider to persist the
  // encrypted team graph that encodes group membership and permissions.
  //
  // The namespace parameter is to prevent collisions with other users of the storage subsystem.
  // Typically this will be the name of the plug-in, adapter, or other system that is using it. For
  // example, the LocalFirstAuthProvider uses the namespace `LocalFirstAuthProvider`.

  /** Loads a value from storage. */
  async load(
    /** Namespace to prevent collisions with other users of the storage subsystem. */
    namespace: string,

    /** Key to load. Typically a UUID or other unique identifier, but could be any string. */
    key: string
  ): Promise<Uint8Array | undefined> {
    const storageKey = [namespace, key] as StorageKey
    return await this.#storageAdapter.load(storageKey)
  }

  /** Saves a value in storage. */
  async save(
    /** Namespace to prevent collisions with other users of the storage subsystem. */
    namespace: string,

    /** Key to load. Typically a UUID or other unique identifier, but could be any string. */
    key: string,

    /** Data to save, as a binary blob. */
    data: Uint8Array
  ): Promise<void> {
    const storageKey = [namespace, key] as StorageKey
    await this.#storageAdapter.save(storageKey, data)
  }

  /** Removes a value from storage. */
  async remove(
    /** Namespace to prevent collisions with other users of the storage subsystem. */
    namespace: string,

    /** Key to remove. Typically a UUID or other unique identifier, but could be any string. */
    key: string
  ): Promise<void> {
    const storageKey = [namespace, key] as StorageKey
    await this.#storageAdapter.remove(storageKey)
  }

  // AUTOMERGE DOCUMENT STORAGE

  /**
   * Loads the Automerge document with the given ID from storage.
   */
  async loadDoc<T>(documentId: DocumentId): Promise<A.Doc<T> | null> {
    const doc = await this.#beelay.loadDocument(documentId)
    if (doc == null) {
      return null
    }
    const binaries = doc.map(c => c.contents)
    const binary = mergeArrays(binaries)
    if (binary.length === 0) return null

    // Load into an Automerge document
    const start = performance.now()
    const newDoc = A.loadIncremental(A.init(), binary) as A.Doc<T>
    const end = performance.now()
    this.emit("document-loaded", {
      documentId,
      durationMillis: end - start,
      ...A.stats(newDoc),
    })

    // Record the latest heads for the document
    this.#storedHeads.set(documentId, A.getHeads(newDoc))
    return newDoc
  }

  /**
   * Saves the provided Automerge document to storage.
   *
   * @remarks
   * Under the hood this makes incremental saves until the incremental size is greater than the
   * snapshot size, at which point the document is compacted into a single snapshot.
   */
  async saveDoc(documentId: DocumentId, doc: A.Doc<unknown>): Promise<void> {
    // Don't bother saving if the document hasn't changed
    if (!this.#shouldSave(documentId, doc)) return

    const changes = A.getChanges(
      A.view(doc, this.#storedHeads.get(documentId) ?? []),
      doc
    )

    const commits = changes.map(c => {
      const decoded = A.decodeChange(c)
      return {
        parents: decoded.deps,
        hash: decoded.hash,
        contents: c,
      }
    })
    let done = this.#beelay
      .addCommits({
        docId: documentId,
        commits: changes.map(c => {
          const decoded = A.decodeChange(c)
          return {
            parents: decoded.deps,
            hash: decoded.hash,
            contents: c,
          }
        }),
      })
      .catch(e => {
        console.error(`Error saving document ${documentId}: ${e}`)
      })
    this.#storedHeads.set(documentId, A.getHeads(doc))
    await done
  }

  /**
   * Removes the Automerge document with the given ID from storage
   */
  async removeDoc(documentId: DocumentId) {
    await this.#storageAdapter.removeRange([documentId, "snapshot"])
    await this.#storageAdapter.removeRange([documentId, "incremental"])
    await this.#storageAdapter.removeRange([documentId, "sync-state"])
  }

  async loadSyncState(
    documentId: DocumentId,
    storageId: StorageId
  ): Promise<A.SyncState | undefined> {
    const key = [documentId, "sync-state", storageId]
    try {
      const loaded = await this.#storageAdapter.load(key)
      return loaded ? A.decodeSyncState(loaded) : undefined
    } catch (e) {
      this.#log(`Error loading sync state for ${documentId} from ${storageId}`)
      return undefined
    }
  }

  async saveSyncState(
    documentId: DocumentId,
    storageId: StorageId,
    syncState: A.SyncState
  ): Promise<void> {
    const key = [documentId, "sync-state", storageId]
    await this.#storageAdapter.save(key, A.encodeSyncState(syncState))
  }

  /**
   * Returns true if the document has changed since the last time it was saved.
   */
  #shouldSave(documentId: DocumentId, doc: A.Doc<unknown>): boolean {
    const oldHeads = this.#storedHeads.get(documentId)
    if (!oldHeads) {
      // we haven't saved this document before
      return true
    }

    const newHeads = A.getHeads(doc)
    if (headsAreSame(newHeads, oldHeads)) {
      // the document hasn't changed
      return false
    }

    return true // the document has changed
  }
}
