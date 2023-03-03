export abstract class StorageAdapter {
  abstract load(docId: string): Promise<Uint8Array | null>
  abstract save(docId: string, data: Uint8Array): void
  abstract remove(docId: string): void
}
