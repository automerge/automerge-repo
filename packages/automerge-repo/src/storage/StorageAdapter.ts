export abstract class StorageAdapter {
  // load, store, or remove a single binary blob based on an array key
  // automerge-repo mostly uses keys in the following form:
  // [documentId, "snapshot"] or [documentId, "incremental", "0"]
  // but the storage adapter is agnostic to the meaning of the key
  // and we expect to store other data in the future such as syncstates
  abstract load(key: StorageKey): Promise<Uint8Array | undefined>
  abstract save(key: StorageKey, data: Uint8Array): Promise<void>
  abstract remove(key: StorageKey): Promise<void>

  // the keyprefix will match any key that starts with the given array
  // for example, [documentId, "incremental"] will match all incremental saves
  // or [documentId] will match all data for a given document
  // be careful! this will also match [documentId, "syncState"]!
  // (we aren't using this yet but keep it in mind.)
  abstract loadRange(keyPrefix: StorageKey): Promise<{key: StorageKey, data: Uint8Array}[]>
  abstract removeRange(keyPrefix: StorageKey): Promise<void>
}

export type  StorageKey = string[]
