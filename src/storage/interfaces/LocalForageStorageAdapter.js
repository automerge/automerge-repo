// Saving & loading
// How should we think about incremental save & load? Log + compaction? TBD.
/* global localforage */
function LocalForageAdapter() {
  return {
    load: (docId) => localforage.getItem(docId),
    save: (docId, binary) => localforage.setItem(docId, binary),
  }
}
export default LocalForageAdapter
