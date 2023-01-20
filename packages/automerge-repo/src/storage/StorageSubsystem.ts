import * as Automerge from "@automerge/automerge"
import { DocumentId } from "../types"
import { mergeArrays } from "../helpers/mergeArrays"
import { StorageAdapter } from "./StorageAdapter"

export class StorageSubsystem {
  #storageAdapter: StorageAdapter
  #incrementalChangeCount: Record<DocumentId, number> = {}

  constructor(storageAdapter: StorageAdapter) {
    this.#storageAdapter = storageAdapter
  }

  saveIncremental(documentId: DocumentId, doc: Automerge.Doc<unknown>) {
    const binary = Automerge.getBackend(doc).saveIncremental()
    if (binary && binary.length > 0) {
      if (!this.#incrementalChangeCount[documentId]) {
        this.#incrementalChangeCount[documentId] = 0
      }

      this.#storageAdapter.save(
        `${documentId}.incremental.${this.#incrementalChangeCount[documentId]}`,
        binary
      )

      this.#incrementalChangeCount[documentId]++
    }
  }

  saveTotal(documentId: DocumentId, doc: Automerge.Doc<unknown>) {
    const binary = Automerge.save(doc)
    this.#storageAdapter.save(`${documentId}.snapshot`, binary)

    for (let i = 0; i < this.#incrementalChangeCount[documentId]; i++) {
      this.#storageAdapter.remove(`${documentId}.incremental.${i}`)
    }

    this.#incrementalChangeCount[documentId] = 0
  }

  async load(storageKey: string): Promise<Uint8Array> {
    const result = []
    let binary = await this.#storageAdapter.load(`${storageKey}.snapshot`)
    if (binary && binary.length > 0) {
      result.push(binary)
    }

    let index = 0
    while (
      (binary = await this.#storageAdapter.load(
        `${storageKey}.incremental.${index}`
      ))
    ) {
      if (binary && binary.length > 0) result.push(binary)
      index += 1
    }

    return mergeArrays(result)
  }

  save(documentId: DocumentId, doc: Automerge.Doc<unknown>) {
    if (this.#shouldCompact(documentId)) {
      this.saveTotal(documentId, doc)
    } else {
      this.saveIncremental(documentId, doc)
    }
  }

  // TODO: make this, you know, good.
  #shouldCompact(documentId: DocumentId) {
    return this.#incrementalChangeCount[documentId] >= 20
  }
}
