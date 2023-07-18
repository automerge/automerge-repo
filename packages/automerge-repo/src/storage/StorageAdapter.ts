export abstract class StorageAdapter {
  abstract load(key: string[]): Promise<Uint8Array | undefined>
  abstract save(key: string[], data: Uint8Array): void
  abstract remove(key: string[]): void
}
