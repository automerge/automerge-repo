import * as A from "@automerge/automerge"
import { StorageAdapter, StorageKey } from "./StorageAdapter.js"
import * as sha256 from "fast-sha256"
import { type DocumentId } from "../types.js"
import { mergeArrays } from "../helpers/mergeArrays.js"

// Metadata about a chunk of data loaded from storage. This is stored on the
// StorageSubsystem so when we are compacting we know what chunks we can safely delete
type StorageChunkInfo = {
  key: StorageKey
  type: ChunkType
  size: number
}

export type ChunkType = "snapshot" | "incremental"

function keyHash(binary: Uint8Array) {
  const hash = sha256.hash(binary)
  const hashArray = Array.from(new Uint8Array(hash)) // convert buffer to byte array
  const hashHex = hashArray.map(b => ("00" + b.toString(16)).slice(-2)).join("") // convert bytes to hex string
  return hashHex
}

function headsHash(heads: A.Heads): string {
  let encoder = new TextEncoder()
  let headsbinary = mergeArrays(heads.map(h => encoder.encode(h)))
  return keyHash(headsbinary)
}

export class StorageSubsystem {
  #storageAdapter: StorageAdapter
  #chunkInfos: Map<DocumentId, StorageChunkInfo[]> = new Map()

  constructor(storageAdapter: StorageAdapter) {
    this.#storageAdapter = storageAdapter
  }

  async #saveIncremental(
    documentId: DocumentId,
    doc: A.Doc<unknown>
  ): Promise<void> {
    const binary = A.saveIncremental(doc)
    if (binary && binary.length > 0) {
      const key = [documentId, "incremental", keyHash(binary)]
      await this.#storageAdapter.save(key, binary)
      if (!this.#chunkInfos.has(documentId)) {
        this.#chunkInfos.set(documentId, [])
      }
      this.#chunkInfos.get(documentId)!!.push({
        key,
        type: "incremental",
        size: binary.length,
      })
    } else {
      return Promise.resolve()
    }
  }

  async #saveTotal(
    documentId: DocumentId,
    doc: A.Doc<unknown>,
    sourceChunks: StorageChunkInfo[]
  ): Promise<void> {
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
  }

  async loadDoc(documentId: DocumentId): Promise<A.Doc<unknown> | null> {
    const loaded = await this.#storageAdapter.loadRange([documentId])
    const binaries = []
    const chunkInfos: StorageChunkInfo[] = []
    for (const chunk of loaded) {
      const chunkType = chunkTypeFromKey(chunk.key)
      if (chunkType == null) {
        continue
      }
      chunkInfos.push({
        key: chunk.key,
        type: chunkType,
        size: chunk.data.length,
      })
      binaries.push(chunk.data)
    }
    this.#chunkInfos.set(documentId, chunkInfos)
    const binary = mergeArrays(binaries)
    if (binary.length === 0) {
      return null
    }
    const newDoc = A.loadIncremental(A.init(), binary)
    return newDoc
  }

  async saveDoc(documentId: DocumentId, doc: A.Doc<unknown>): Promise<void> {
    let sourceChunks = this.#chunkInfos.get(documentId) ?? []
    console.log(
      "Saving",
      documentId,
      sourceChunks,
      this.#shouldCompact(sourceChunks)
    )
    if (this.#shouldCompact(sourceChunks)) {
      this.#saveTotal(documentId, doc, sourceChunks)
    } else {
      this.#saveIncremental(documentId, doc)
    }
  }

  async remove(documentId: DocumentId) {
    this.#storageAdapter.remove([documentId, "snapshot"])
    this.#storageAdapter.removeRange([documentId, "incremental"])
  }

  #shouldCompact(sourceChunks: StorageChunkInfo[]) {
    // compact if the incremental size is greater than the snapshot size
    let snapshotSize = 0
    let incrementalSize = 0
    for (const chunk of sourceChunks) {
      if (chunk.type === "snapshot") {
        snapshotSize += chunk.size
      } else {
        incrementalSize += chunk.size
      }
    }
    return incrementalSize > snapshotSize
  }
}

function chunkTypeFromKey(key: StorageKey): ChunkType | null {
  if (key.length < 2) {
    return null
  }
  const chunkTypeStr = key[key.length - 2]
  if (chunkTypeStr === "snapshot" || chunkTypeStr === "incremental") {
    const chunkType: ChunkType = chunkTypeStr
    return chunkType
  } else {
    return null
  }
}
