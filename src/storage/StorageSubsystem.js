export class StorageSubsystem {
  storageAdapter;

  constructor(storageAdapter) {
    this.storageAdapter = storageAdapter;
  }

  onDocument(e) {
    const { documentId, doc } = e.detail;
    doc.addEventListener('change', (e) => {
      const { documentId, doc } = e.detail;
      // this is obviously inefficient and we should do incremental save 
      // and/or occasional compaction
      const binary = Automerge.save(doc);
      this.storageAdapter.save(documentId, binary);
    });
  }

  async load(docId) {
    const binary = await this.storageAdapter.load(docId);
    if (!binary) return null
    return Automerge.load(binary)
  }
}
