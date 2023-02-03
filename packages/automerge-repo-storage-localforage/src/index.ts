import * as localforage from "localforage"
import { StorageAdapter } from "automerge-repo"

type LocalForageStorageAdapterOptions = {
  localforage?: LocalForageDbMethodsCore
}

/** Saving & loading via localforage. Very naive but probably fine for blob-storage.  */
export class LocalForageStorageAdapter implements StorageAdapter {
  #localforage: LocalForageDbMethodsCore;
  
  constructor(options: LocalForageStorageAdapterOptions = {}) {
    this.#localforage = options.localforage || localforage;
  }
  
  get localforage() {
    return this.#localforage;
  }
  
  load(docId: string) {
    return this.#localforage.getItem<Uint8Array>(docId)
  }

  save(docId: string, binary: Uint8Array) {
    this.#localforage.setItem(docId, binary)
  }

  remove(docId: string) {
    this.#localforage.removeItem(docId)
  }
}
