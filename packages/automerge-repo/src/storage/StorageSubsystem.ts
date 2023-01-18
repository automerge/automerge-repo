import * as Automerge from "@automerge/automerge"
import { DocumentId } from "../types"
import { mergeArrays } from "../helpers/mergeArrays"
import { StorageAdapter } from "./StorageAdapter"

export class StorageSubsystem {
  storageAdapter: StorageAdapter

  constructor(storageAdapter: StorageAdapter) {
    this.storageAdapter = storageAdapter
  }

  incrementalChanges: { [docId: DocumentId]: number } = {}

  saveIncremental(documentId: DocumentId, doc: Automerge.Doc<unknown>) {
    const binary = Automerge.getBackend(doc).saveIncremental()
    if (binary && binary.length > 0) {
      if (!this.incrementalChanges[documentId]) {
        this.incrementalChanges[documentId] = 0
      }

      this.storageAdapter.save(
        `${documentId}.incremental.${this.incrementalChanges[documentId]}`,
        binary
      )

      this.incrementalChanges[documentId]++
    }
  }

  saveTotal(documentId: DocumentId, doc: Automerge.Doc<unknown>) {
    const binary = Automerge.save(doc)
    this.storageAdapter.save(`${documentId}.snapshot`, binary)

    for (let i = 0; i < this.incrementalChanges[documentId]; i++) {
      this.storageAdapter.remove(`${documentId}.incremental.${i}`)
    }

    this.incrementalChanges[documentId] = 0
  }

  async load(storageKey: string): Promise<Uint8Array> {
    const result = []
    let binary = await this.storageAdapter.load(`${storageKey}.snapshot`)
    if (binary && binary.length > 0) {
      result.push(binary)
    }

    let index = 0
    while (
      (binary = await this.storageAdapter.load(
        `${storageKey}.incremental.${index}`
      ))
    ) {
      if (binary && binary.length > 0) {
        result.push(binary)
      }
      index += 1
    }

    return mergeArrays(result)
  }

  // TODO: make this, you know, good.
  shouldCompact(documentId: DocumentId) {
    return this.incrementalChanges[documentId] >= 20
  }

  save(documentId: DocumentId, doc: Automerge.Doc<unknown>) {
    if (this.shouldCompact(documentId)) {
      this.saveTotal(documentId, doc)
    } else {
      this.saveIncremental(documentId, doc)
    }
  }
}
