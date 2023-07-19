import * as A from "@automerge/automerge"
import { DocumentId } from "../types.js"
import { StorageAdapter } from "./StorageAdapter.js"
import { mergeArrays } from "../helpers/mergeArrays.js"
import * as crypto from "crypto"

// stick in helpers before merging
function hashUint8Array(data: Uint8Array): string {
  const hash = crypto.createHash("sha256")
  hash.update(Buffer.from(data.buffer))
  const result = hash.digest("hex")
  return result
}

export class StorageSubsystem {
  #storageAdapter: StorageAdapter

  constructor(storageAdapter: StorageAdapter) {
    this.#storageAdapter = storageAdapter
  }

  async #saveIncremental(documentId: DocumentId, doc: A.Doc<unknown>) {
    const binary = A.saveIncremental(doc)
    if (binary && binary.length > 0) {
      const key = [documentId, "incremental", await hashUint8Array(binary)]
      return await this.#storageAdapter.save(key, binary)
    }
    Promise.resolve(undefined)
  }

  async #saveTotal(documentId: DocumentId, doc: A.Doc<unknown>) {
    const binary = A.save(doc)

    // TODO: this is still racy if two nodes are both writing to the store
    await this.#storageAdapter.save([documentId, "snapshot"], binary)

    // don't start deleting the incremental keys until save is done!
    return this.#storageAdapter.removeRange([documentId, "incremental"])
  }

  async loadBinary(documentId: DocumentId): Promise<Uint8Array> {
    // it would probably be best to ensure .snapshot comes back first
    // prevent the race condition with saveIncremental
    const binaries: Uint8Array[] = await this.#storageAdapter.loadRange([
      documentId,
    ])

    return mergeArrays(binaries)
  }

  async load<T>(
    documentId: DocumentId,
    prevDoc: A.Doc<T> = A.init<T>()
  ): Promise<A.Doc<T>> {
    const doc = A.loadIncremental(prevDoc, await this.loadBinary(documentId))
    A.saveIncremental(doc)
    return doc
  }

  async save(documentId: DocumentId, doc: A.Doc<unknown>) {
    if (this.#shouldCompact(documentId)) {
      return this.#saveTotal(documentId, doc)
    } else {
      return this.#saveIncremental(documentId, doc)
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
