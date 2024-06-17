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

/**
 * The storage subsystem is responsible for saving and loading Automerge documents to and from
 * storage adapter. It also provides a generic key/value storage interface for other uses.
 */
export class StorageSubsystem {
  /** The storage adapter to use for saving and loading documents */
  #storageAdapter: StorageAdapterInterface

  /** Record of the latest heads we've loaded or saved for each document  */
  #storedHeads: Map<DocumentId, A.Heads> = new Map()

  /** Metadata on the chunks we've already loaded for each document */
  #chunkInfos: Map<DocumentId, ChunkInfo[]> = new Map()

  /** Flag to avoid compacting when a compaction is already underway */
  #compacting = false

  #log = debug(`automerge-repo:storage-subsystem`)

  constructor(storageAdapter: StorageAdapterInterface) {
    this.#storageAdapter = storageAdapter
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
    // Load all the chunks for this document
    const chunks = await this.#storageAdapter.loadRange([documentId])
    const binaries = []
    const chunkInfos: ChunkInfo[] = []

    for (const chunk of chunks) {
      // chunks might have been deleted in the interim
      if (chunk.data === undefined) continue

      const chunkType = chunkTypeFromKey(chunk.key)
      if (chunkType == null) continue

      chunkInfos.push({
        key: chunk.key,
        type: chunkType,
        size: chunk.data.length,
      })
      binaries.push(chunk.data)
    }
    this.#chunkInfos.set(documentId, chunkInfos)

    // Merge the chunks into a single binary
    const binary = mergeArrays(binaries)
    if (binary.length === 0) return null

    // Load into an Automerge document
    const newDoc = A.loadIncremental(A.init(), binary) as A.Doc<T>

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

    const sourceChunks = this.#chunkInfos.get(documentId) ?? []
    if (this.#shouldCompact(sourceChunks)) {
      await this.#saveTotal(documentId, doc, sourceChunks)
    } else {
      await this.#saveIncremental(documentId, doc)
    }
    this.#storedHeads.set(documentId, A.getHeads(doc))
  }

  /**
   * Removes the Automerge document with the given ID from storage
   */
  async removeDoc(documentId: DocumentId) {
    await this.#storageAdapter.removeRange([documentId, "snapshot"])
    await this.#storageAdapter.removeRange([documentId, "incremental"])
    await this.#storageAdapter.removeRange([documentId, "sync-state"])
  }

  /**
   * Saves just the incremental changes since the last save.
   */
  async #saveIncremental(
    documentId: DocumentId,
    doc: A.Doc<unknown>
  ): Promise<void> {
    const binary = A.saveSince(doc, this.#storedHeads.get(documentId) ?? [])
    if (binary && binary.length > 0) {
      const key = [documentId, "incremental", keyHash(binary)]
      this.#log(`Saving incremental ${key} for document ${documentId}`)
      await this.#storageAdapter.save(key, binary)
      if (!this.#chunkInfos.has(documentId)) {
        this.#chunkInfos.set(documentId, [])
      }
      this.#chunkInfos.get(documentId)!.push({
        key,
        type: "incremental",
        size: binary.length,
      })
      this.#storedHeads.set(documentId, A.getHeads(doc))
    } else {
      return Promise.resolve()
    }
  }

  /**
   * Compacts the document storage into a single shapshot.
   */
  async #saveTotal(
    documentId: DocumentId,
    doc: A.Doc<unknown>,
    sourceChunks: ChunkInfo[]
  ): Promise<void> {
    this.#compacting = true

    const binary = A.save(doc)
    const snapshotHash = headsHash(A.getHeads(doc))
    const key = [documentId, "snapshot", snapshotHash]
    const oldKeys = new Set(
      sourceChunks.map(c => c.key).filter(k => k[2] !== snapshotHash)
    )

    this.#log(`Saving snapshot ${key} for document ${documentId}`)
    this.#log(`deleting old chunks ${Array.from(oldKeys)}`)

    await this.#storageAdapter.save(key, binary)

    for (const key of oldKeys) {
      await this.#storageAdapter.remove(key)
    }

    const newChunkInfos =
      this.#chunkInfos.get(documentId)?.filter(c => !oldKeys.has(c.key)) ?? []
    newChunkInfos.push({ key, type: "snapshot", size: binary.length })

    this.#chunkInfos.set(documentId, newChunkInfos)
    this.#compacting = false
  }

  async loadSyncState(
    documentId: DocumentId,
    storageId: StorageId
  ): Promise<A.SyncState | undefined> {
    const key = [documentId, "sync-state", storageId]
    const loaded = await this.#storageAdapter.load(key)
    return loaded ? A.decodeSyncState(loaded) : undefined
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

  /**
   * We only compact if the incremental size is greater than the snapshot size.
   */
  #shouldCompact(sourceChunks: ChunkInfo[]) {
    if (this.#compacting) return false

    let snapshotSize = 0
    let incrementalSize = 0
    for (const chunk of sourceChunks) {
      if (chunk.type === "snapshot") {
        snapshotSize += chunk.size
      } else {
        incrementalSize += chunk.size
      }
    }
    // if the file is currently small, don't worry, just compact
    // this might seem a bit arbitrary (1k is arbitrary) but is designed to ensure compaction
    // for documents with only a single large change on top of an empty (or nearly empty) document
    // for example: imported NPM modules, images, etc.
    // if we have even more incrementals (so far) than the snapshot, compact
    return snapshotSize < 1024 || incrementalSize >= snapshotSize
  }
}
