import { StorageAdapter } from '../StorageSubsystem'

class MemoryStorageAdapter implements StorageAdapter {
  data: {[id: string] : Uint8Array } = {}
  load(docId: string) { return new Promise<Uint8Array | null>((resolve) => resolve(this.data[docId] || null)) }
  save(docId: string, binary: Uint8Array) { this.data[docId] = binary }
  remove(docId: string) { delete this.data[docId] }
}
export default MemoryStorageAdapter
