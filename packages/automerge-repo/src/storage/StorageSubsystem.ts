import * as Automerge from "@automerge/automerge"
import { DocumentId } from "../DocHandle"

export interface StorageAdapter {
  load(docId: string): Promise<Uint8Array | null>
  save(docId: string, data: Uint8Array): void
  remove(docId: string): void
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

  async load(
    documentId: DocumentId,
    doc: Automerge.Doc<unknown>
  ): Promise<Automerge.Doc<unknown>> {
    let binary = await this.storageAdapter.load(`${documentId}.snapshot`)
    console.log(documentId, "got binary", binary)

    if (binary && binary.length > 0) {
      // TODO: this generates patches for every change along the way
      doc = Automerge.loadIncremental(doc, binary)
      console.log(documentId, "loaded base", JSON.stringify(doc))
    }

    let index = 0
    while (
      (binary = await this.storageAdapter.load(
        `${documentId}.incremental.${index}`
      ))
    ) {
      if (binary && binary.length > 0) {
        doc = Automerge.loadIncremental(doc, binary)
        console.log(
          documentId,
          "loaded incremental ",
          index,
          JSON.stringify(doc)
        )
      }
      index += 1
    }

    this.incrementalChanges[documentId] = index

    console.log(documentId, "loaded base", JSON.stringify(doc))
    return doc
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
