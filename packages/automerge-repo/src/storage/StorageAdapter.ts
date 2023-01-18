export interface StorageAdapter {
  load(docId: string): Promise<Uint8Array | null>
  save(docId: string, data: Uint8Array): void
  remove(docId: string): void
}
