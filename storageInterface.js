// Saving & loading
// How should we think about incremental save & load? Log + compaction? TBD.
const storageInterface = {
    load: (docId) => localforage.getItem(docId),
    save: (docId, binary) => localforage.setItem(docId, binary).catch(err => console.log(err))
};
export default storageInterface;
