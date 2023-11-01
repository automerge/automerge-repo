import * as A from "@automerge/automerge/next"
import debug from "debug"
import * as sha256 from "fast-sha256"
import { headsAreSame } from "../helpers/headsAreSame.js"
import { mergeArrays } from "../helpers/mergeArrays.js"
import { PeerId, type DocumentId } from "../types.js"
import { StorageAdapter, StorageKey } from "./StorageAdapter.js"

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
  const encoder = new TextEncoder()
  const headsbinary = mergeArrays(heads.map((h: string) => encoder.encode(h)))
  return keyHash(headsbinary)
}

export class StorageSubsystem {
  #storageAdapter: StorageAdapter
  #chunkInfos: Map<DocumentId, StorageChunkInfo[]> = new Map()
  #storedHeads: Map<DocumentId, A.Heads> = new Map()
  #log = debug(`automerge-repo:storage-subsystem`)

  #snapshotting = false

  constructor(storageAdapter: StorageAdapter) {
    this.#storageAdapter = storageAdapter
  }

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

  async #saveTotal(
    documentId: DocumentId,
    doc: A.Doc<unknown>,
    sourceChunks: StorageChunkInfo[]
  ): Promise<void> {
    this.#snapshotting = true
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
    this.#snapshotting = false
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
    this.#storedHeads.set(documentId, A.getHeads(newDoc))
    return newDoc
  }

  async saveDoc(documentId: DocumentId, doc: A.Doc<unknown>): Promise<void> {
    if (!this.#shouldSave(documentId, doc)) {
      return
    }
    const sourceChunks = this.#chunkInfos.get(documentId) ?? []
    if (this.#shouldCompact(sourceChunks)) {
      void this.#saveTotal(documentId, doc, sourceChunks)
    } else {
      void this.#saveIncremental(documentId, doc)
    }
    this.#storedHeads.set(documentId, A.getHeads(doc))
  }

  // todo: we should store individual sync states and load the combined syncState object with loadRange
  // unfortunately this is currently not possible because we would have to put the documentId as the first key
  // this conflicts with documents are currently loaded

  async loadSyncStates(
    documentId: DocumentId
  ): Promise<Record<PeerId, A.SyncState>> {
    const key = [documentId, "sync-states"]

    const serializedSyncState = await this.#storageAdapter.load(key)

    if (!serializedSyncState) {
      return {}
    }

    try {
      return deserializeSyncStates(serializedSyncState)
    } catch (err) {
      return {}
    }
  }

  async saveSyncStates(
    documentId: DocumentId,
    syncStates: Record<PeerId, A.SyncState>
  ): Promise<void> {
    const key = [documentId, "sync-states"]

    await this.#storageAdapter.save(key, serializeSyncStates(syncStates))
  }

  async remove(documentId: DocumentId) {
    void this.#storageAdapter.removeRange([documentId, "snapshot"])
    void this.#storageAdapter.removeRange([documentId, "incremental"])
  }

  #shouldSave(documentId: DocumentId, doc: A.Doc<unknown>): boolean {
    const oldHeads = this.#storedHeads.get(documentId)
    if (!oldHeads) {
      return true
    }

    const newHeads = A.getHeads(doc)
    if (headsAreSame(newHeads, oldHeads)) {
      return false
    }

    return true
  }

  #shouldCompact(sourceChunks: StorageChunkInfo[]) {
    if (this.#snapshotting) {
      return false
    }
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
    return incrementalSize >= snapshotSize
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

function serializeSyncStates(
  syncStates: Record<PeerId, A.SyncState>
): Uint8Array {
  const encoder = new TextEncoder()
  return encoder.encode(
    JSON.stringify(syncStates, (key, value) => {
      if (key === "bloom") {
        const array = new Uint8Array(value as ArrayBuffer) // type assertion
        const str = String.fromCharCode.apply(null, Array.from(array))
        return btoa(str)
      }
      return value
    })
  )
}

function deserializeSyncStates(
  serializedSyncState: Uint8Array
): Record<PeerId, A.SyncState> {
  const decoder = new TextDecoder()
  return JSON.parse(decoder.decode(serializedSyncState), (key, value) => {
    if (key === "bloom") {
      const binaryString = atob(value)
      const len = binaryString.length
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }
      return bytes
    }
    return value
  })
}
