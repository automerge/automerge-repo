export class RepoDoc extends EventTarget {
  doc;

  constructor(documentId, doc) {
    super();
    if (!documentId) { throw new Error("Need a document ID for this RepoDoc.")}
    this.documentId = documentId;
    if (!doc) { throw new Error("Missing the automerge data for this RepoDoc.")}
    this.doc = doc;
  }

  change(callback) {
    const doc = Automerge.change(this.doc, callback);
    this.replace(doc);
  }

  replace(doc) {
    this.doc = doc;
    const documentId = this.documentId;
    this.dispatchEvent(
      new CustomEvent('change', { detail: { documentId, doc, origin: 'remote' } })
    );
  }

  /* hmmmmmmmmmmm */
  value() {
    return this.doc;
  }
}
