import * as A from "@automerge/automerge"
import { DocumentId } from "../types.js"
import { StorageAdapter } from "./StorageAdapter.js"
import { mergeArrays } from "../helpers/mergeArrays.js"

// stick in helpers before merging
async function hashUint8Array(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("")
  return hashHex
}

export class StorageSubsystem {
  #storageAdapter: StorageAdapter

  constructor(storageAdapter: StorageAdapter) {
    this.#storageAdapter = storageAdapter
  }

  async #saveIncremental(documentId: DocumentId, doc: A.Doc<unknown>) {
    const binary = A.saveIncremental(doc)
    if (binary && binary.length > 0) {
      this.#storageAdapter.save(
        [documentId, "incremental", await hashUint8Array(binary)],
        binary
      )
    }
  }

  async #saveTotal(documentId: DocumentId, doc: A.Doc<unknown>) {
    console.log("saving total", documentId, doc)
    const binary = A.save(doc)
    // this is still racy if two nodes are both writing to the store
    this.#storageAdapter.save([documentId, "snapshot"], binary)
    this.#storageAdapter.removeRange([documentId, "incremental"])
  }

  async loadBinary(documentId: DocumentId): Promise<Uint8Array> {
    // it would probably be best to ensure .snapshot comes back first
    // prevent the race condition with saveIncremental
    const binaries: Uint8Array[] = await this.#storageAdapter.loadRange([
      documentId,
    ])

    console.log("binaries", binaries)
    return mergeArrays(binaries)
  }

  async load<T>(
    documentId: DocumentId,
    prevDoc: A.Doc<T> = A.init<T>()
  ): Promise<A.Doc<T>> {
    console.log("coming in via load", documentId, prevDoc)
    const doc = A.loadIncremental(prevDoc, await this.loadBinary(documentId))
    A.saveIncremental(doc)
    return doc
  }

  async save(documentId: DocumentId, doc: A.Doc<unknown>) {
    if (this.#shouldCompact(documentId)) {
      this.#saveTotal(documentId, doc)
    } else {
      this.#saveIncremental(documentId, doc)
    }
  }

  async remove(documentId: DocumentId) {
    this.#storageAdapter.remove([documentId, "snapshot"])
    this.#storageAdapter.removeRange([documentId, "incremental"])
  }

  // TODO: make this, you know, good.
  // this is probably fine
  #shouldCompact(documentId: DocumentId) {
    return Math.random() < 0.05 // this.#changeCount[documentId] >= 20
  }
}
