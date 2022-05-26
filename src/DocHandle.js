/* global Automerge */
export default class DocHandle extends EventTarget {
  doc

  documentId

  constructor(documentId) {
    super()
    if (!documentId) { throw new Error('Need a document ID for this RepoDoc.') }
    this.documentId = documentId
  }

  // should i move this?
  change(callback) {
    const doc = Automerge.change(this.doc, callback)
    this.replace(doc)
  }

  replace(doc) {
    this.doc = doc
    const { documentId } = this
    this.dispatchEvent(
      new CustomEvent('change', { detail: { handle: this, documentId, doc } }),
    )
  }

  /* hmmmmmmmmmmm */
  async value() {
    if (!this.doc) {
      await new Promise((resolve) => {
        this.addEventListener('change', resolve, {
          once: true,
        })
      })
    }
    return this.doc
  }
}
