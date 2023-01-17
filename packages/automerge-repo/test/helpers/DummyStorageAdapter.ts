import { DocumentId, StorageAdapter } from "../../src"

export class DummyStorageAdapter implements StorageAdapter {
  #data: Record<DocumentId, Uint8Array> = {}

  load(docId: DocumentId) {
    return new Promise<Uint8Array | null>(resolve =>
      resolve(this.#data[docId] || null)
    )
  }

  save(docId: DocumentId, binary: Uint8Array) {
    this.#data[docId] = binary
  }

  remove(docId: DocumentId) {
    delete this.#data[docId]
  }
}
