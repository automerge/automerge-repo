import * as A from "@automerge/automerge"
import { type EncodedDocumentId } from "../types.js"
import { mergeArrays } from "../helpers/mergeArrays.js"
import { StorageAdapter } from "./StorageAdapter.js"

export class StorageSubsystem {
  #storageAdapter: StorageAdapter
  #changeCount: Record<EncodedDocumentId, number> = {}

  constructor(storageAdapter: StorageAdapter) {
    this.#storageAdapter = storageAdapter
  }

  #saveIncremental(encodedDocumentId: EncodedDocumentId, doc: A.Doc<unknown>) {
    const binary = A.saveIncremental(doc)
    if (binary && binary.length > 0) {
      if (!this.#changeCount[encodedDocumentId]) {
        this.#changeCount[encodedDocumentId] = 0
      }

      this.#storageAdapter.save(
        `${encodedDocumentId}.incremental.${
          this.#changeCount[encodedDocumentId]
        }`,
        binary
      )

      this.#changeCount[encodedDocumentId]++
    }
  }

  #saveTotal(encodedDocumentId: EncodedDocumentId, doc: A.Doc<unknown>) {
    const binary = A.save(doc)
    this.#storageAdapter.save(`${encodedDocumentId}.snapshot`, binary)

    for (let i = 0; i < this.#changeCount[encodedDocumentId]; i++) {
      this.#storageAdapter.remove(`${encodedDocumentId}.incremental.${i}`)
    }

    this.#changeCount[encodedDocumentId] = 0
  }

  async loadBinary(encodedDocumentId: EncodedDocumentId): Promise<Uint8Array> {
    const result = []
    let binary = await this.#storageAdapter.load(
      `${encodedDocumentId}.snapshot`
    )
    if (binary && binary.length > 0) {
      result.push(binary)
    }

    let index = 0
    while (
      (binary = await this.#storageAdapter.load(
        `${encodedDocumentId}.incremental.${index}`
      ))
    ) {
      this.#changeCount[encodedDocumentId] = index + 1
      if (binary && binary.length > 0) result.push(binary)
      index += 1
    }

    return mergeArrays(result)
  }

  async load<T>(
    encodedDocumentId: EncodedDocumentId,
    prevDoc: A.Doc<T> = A.init<T>()
  ): Promise<A.Doc<T>> {
    const doc = A.loadIncremental(
      prevDoc,
      await this.loadBinary(encodedDocumentId)
    )
    A.saveIncremental(doc)
    return doc
  }

  save(encodedDocumentId: EncodedDocumentId, doc: A.Doc<unknown>) {
    if (this.#shouldCompact(encodedDocumentId)) {
      this.#saveTotal(encodedDocumentId, doc)
    } else {
      this.#saveIncremental(encodedDocumentId, doc)
    }
  }

  remove(encodedDocumentId: EncodedDocumentId) {
    this.#storageAdapter.remove(`${encodedDocumentId}.snapshot`)

    for (let i = 0; i < this.#changeCount[encodedDocumentId]; i++) {
      this.#storageAdapter.remove(`${encodedDocumentId}.incremental.${i}`)
    }
  }

  // TODO: make this, you know, good.
  #shouldCompact(encodedDocumentId: EncodedDocumentId) {
    return this.#changeCount[encodedDocumentId] >= 20
  }
}
