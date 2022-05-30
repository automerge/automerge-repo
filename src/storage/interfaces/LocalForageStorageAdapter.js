// Saving & loading via localforage. Very naive but probably fine for blob-storage.
import localforage from 'localforage'

function LocalForageAdapter() {
  return {
    load: (docId) => localforage.getItem(docId),
    save: (docId, binary) => localforage.setItem(docId, binary),
    remove: (docId) => localforage.removeItem(docId),
  }
}
export default LocalForageAdapter
