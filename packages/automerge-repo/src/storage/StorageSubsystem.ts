import * as A from "@automerge/automerge"
import { DocumentId } from "../types.js"
import { mergeArrays } from "../helpers/mergeArrays.js"
import { StorageAdapter } from "./StorageAdapter.js"

export class StorageSubsystem {
  #storageAdapter: StorageAdapter
  #changeCount: Record<DocumentId, number> = {}

  constructor(storageAdapter: StorageAdapter) {
    this.#storageAdapter = storageAdapter
  }

  #saveIncremental(documentId: DocumentId, doc: A.Doc<unknown>) {
    const binary = A.getBackend(doc).saveIncremental()
    if (binary && binary.length > 0) {
      if (!this.#changeCount[documentId]) {
        this.#changeCount[documentId] = 0
      }

      this.#storageAdapter.save(
        `${documentId}.incremental.${this.#changeCount[documentId]}`,
        binary
      )

      this.#changeCount[documentId]++
    }
  }

  #saveTotal(documentId: DocumentId, doc: A.Doc<unknown>) {
    const binary = A.save(doc)
    this.#storageAdapter.save(`${documentId}.snapshot`, binary)

    for (let i = 0; i < this.#changeCount[documentId]; i++) {
      this.#storageAdapter.remove(`${documentId}.incremental.${i}`)
    }

    this.#changeCount[documentId] = 0
  }

  async loadBinary(documentId: DocumentId): Promise<Uint8Array> {
    const result = []
    let binary = await this.#storageAdapter.load(`${documentId}.snapshot`)
    if (binary && binary.length > 0) {
      result.push(binary)
    }

    let index = 0
    while (
      (binary = await this.#storageAdapter.load(
        `${documentId}.incremental.${index}`
      ))
    ) {
      this.#changeCount[documentId] = index + 1
      if (binary && binary.length > 0) result.push(binary)
      index += 1
    }

    return mergeArrays(result)
  }

  async load<T>(
    documentId: DocumentId,
    prevDoc: A.Doc<T> = A.init<T>()
  ): Promise<A.Doc<T>> {
    return A.loadIncremental(prevDoc, await this.loadBinary(documentId))
  }

  save(documentId: DocumentId, doc: A.Doc<unknown>) {
    if (this.#shouldCompact(documentId)) {
      this.#saveTotal(documentId, doc)
    } else {
      this.#saveIncremental(documentId, doc)
    }
  }

  // TODO: make this, you know, good.
  #shouldCompact(documentId: DocumentId) {
    return this.#changeCount[documentId] >= 20
  }
}
