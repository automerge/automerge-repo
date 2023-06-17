import * as localforage from "localforage"
import { StorageAdapter } from "@automerge/automerge-repo"

/** Saving & loading via localforage. Very naive but probably fine for blob-storage.  */
export class LocalForageStorageAdapter extends StorageAdapter {
  load(docId: string) {
    return localforage.getItem<Uint8Array>(docId)
  }

  save(docId: string, binary: Uint8Array) {
    localforage.setItem(docId, binary)
  }

  remove(docId: string) {
    localforage.removeItem(docId)
  }
}
