import * as Automerge from "@automerge/automerge"
import { DocumentId } from "../DocHandle"

export interface StorageAdapter {
  load(docId: string): Promise<Uint8Array | null>
  save(docId: string, data: Uint8Array): void
  remove(docId: string): void
}

function mergeArrays(myArrays: Uint8Array[]) {
  // Get the total length of all arrays.
  let length = 0
  myArrays.forEach((item) => {
    length += item.length
  })

  // Create a new array with total length and merge all source arrays.
  const mergedArray = new Uint8Array(length)
  let offset = 0
  myArrays.forEach((item) => {
    mergedArray.set(item, offset)
    offset += item.length
  })

  return mergedArray
}
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
    return this.incrementalChanges[documentId] >= 2
  }

  save(documentId: DocumentId, doc: Automerge.Doc<unknown>) {
    if (this.shouldCompact(documentId)) {
      this.saveTotal(documentId, doc)
    } else {
      this.saveIncremental(documentId, doc)
    }
  }
}
