// Saving & loading via localforage. Very naive but probably fine for blob-storage.
import localforage from 'localforage'
import { StorageAdapter } from '../StorageSubsystem'

class LocalForageAdapter implements StorageAdapter {
  load(docId: string) { return localforage.getItem<Uint8Array>(docId) }
  save(docId: string, binary: Uint8Array) { localforage.setItem(docId, binary) }
  remove(docId: string) { localforage.removeItem(docId) }
}
export default LocalForageAdapter
