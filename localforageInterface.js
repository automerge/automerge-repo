// Saving & loading
// How should we think about incremental save & load? Log + compaction? TBD.
function StorageInterface() {
  return {
    load: (docId) => localforage.getItem(docId),
    save: (docId, binary) =>
      localforage.setItem(docId, binary).catch((err) => console.log(err)),
  }
}
export default StorageInterface;
