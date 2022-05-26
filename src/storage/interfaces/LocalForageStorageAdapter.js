// Saving & loading
// How should we think about incremental save & load? Log + compaction? TBD.

function LocalForageAdapter() {
  return {
    load: (docId) => localforage.getItem(docId),
    save: (docId, binary) => localforage.setItem(docId, binary),
    remove: (docId) => localforage.removeItem(docId),
  }
}
export default LocalForageAdapter
