import * as A from "@automerge/automerge/next"
import debug from "debug"
import { headsAreSame } from "../helpers/headsAreSame.js"
import { mergeArrays } from "../helpers/mergeArrays.js"
import { type DocumentId } from "../types.js"
import { StorageAdapter } from "./StorageAdapter.js"
import { ChunkInfo, StorageKey } from "./types.js"
import { keyHash, headsHash } from "./keyHash.js"
import { chunkTypeFromKey } from "./chunkTypeFromKey.js"

/**
 * The storage subsystem is responsible for saving and loading Automerge documents to and from
 * storage adapter. It also provides a generic key/value storage interface for other uses.
 */
export class StorageSubsystem {
  /** Record of the latest heads we've loaded or saved for each document  */
  #storedHeads: Map<DocumentId, A.Heads> = new Map()

  /** Metadata on the chunks we've already loaded for each document */
  #chunkInfos: Map<DocumentId, ChunkInfo[]> = new Map()

  /** Flag to avoid compacting when a compaction is already underway */
  #compacting = false

  #log = debug(`automerge-repo:storage-subsystem`)

  constructor(private storageAdapter: StorageAdapter) {}

  /**
   * Loads the Automerge document with the given ID from storage.
   */
  async loadDoc<T>(documentId: DocumentId): Promise<A.Doc<T> | null> {
    // Load all the chunks for this document
    const chunks = await this.storageAdapter.loadRange([documentId])
    const binaries = []
    const chunkInfos: ChunkInfo[] = []

    for (const chunk of chunks) {
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
      void this.#saveTotal(documentId, doc, sourceChunks)
    } else {
      void this.#saveIncremental(documentId, doc)
    }
    this.#storedHeads.set(documentId, A.getHeads(doc))
  }

  /**
   * Removes the Automerge document with the given ID from storage
   */
  async remove(documentId: DocumentId) {
    void this.storageAdapter.removeRange([documentId, "snapshot"])
    void this.storageAdapter.removeRange([documentId, "incremental"])
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
      await this.storageAdapter.save(key, binary)
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

    await this.storageAdapter.save(key, binary)

    for (const key of oldKeys) {
      await this.storageAdapter.remove(key)
    }

    const newChunkInfos =
      this.#chunkInfos.get(documentId)?.filter(c => !oldKeys.has(c.key)) ?? []
    newChunkInfos.push({ key, type: "snapshot", size: binary.length })

    this.#chunkInfos.set(documentId, newChunkInfos)

    this.#compacting = false
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
    return incrementalSize >= snapshotSize
  }
}
