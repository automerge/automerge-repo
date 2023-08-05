import * as A from "@automerge/automerge"
import { DocumentId, StringDocumentId } from "../types.js"
import { mergeArrays } from "../helpers/mergeArrays.js"
import { StorageAdapter } from "./StorageAdapter.js"
import { encode } from "../DocUrl.js"

export class StorageSubsystem {
  #storageAdapter: StorageAdapter
  #changeCount: Record<StringDocumentId, number> = {}

  constructor(storageAdapter: StorageAdapter) {
    this.#storageAdapter = storageAdapter
  }

  #saveIncremental(binaryDocumentId: DocumentId, doc: A.Doc<unknown>) {
    const documentId = encode(binaryDocumentId)
    const binary = A.saveIncremental(doc)
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

  #saveTotal(binaryDocumentId: DocumentId, doc: A.Doc<unknown>) {
    const documentId = encode(binaryDocumentId)
    const binary = A.save(doc)
    this.#storageAdapter.save(`${documentId}.snapshot`, binary)

    for (let i = 0; i < this.#changeCount[documentId]; i++) {
      this.#storageAdapter.remove(`${documentId}.incremental.${i}`)
    }

    this.#changeCount[documentId] = 0
  }

  async loadBinary(binaryDocumentId: DocumentId): Promise<Uint8Array> {
    const documentId = encode(binaryDocumentId)
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
    const doc = A.loadIncremental(prevDoc, await this.loadBinary(documentId))
    A.saveIncremental(doc)
    return doc
  }

  save(documentId: DocumentId, doc: A.Doc<unknown>) {
    if (this.#shouldCompact(documentId)) {
      this.#saveTotal(documentId, doc)
    } else {
      this.#saveIncremental(documentId, doc)
    }
  }

  remove(binaryDocumentId: DocumentId) {
    const documentId = encode(binaryDocumentId)
    this.#storageAdapter.remove(`${documentId}.snapshot`)

    for (let i = 0; i < this.#changeCount[documentId]; i++) {
      this.#storageAdapter.remove(`${documentId}.incremental.${i}`)
    }
  }

  // TODO: make this, you know, good.
  #shouldCompact(binaryDocumentId: DocumentId) {
    const documentId = encode(binaryDocumentId)
    return this.#changeCount[documentId] >= 20
  }
}
