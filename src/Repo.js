import { RepoDoc } from "./RepoDoc.js"

export default class Repo extends EventTarget {
  docs = {}

  constructor() {
    super()
  }
  
  create() {
    const documentId = crypto.randomUUID()
    const doc = new RepoDoc(documentId, Automerge.init())
    this.docs[documentId] = doc
    this.dispatchEvent(new CustomEvent('document', { detail: { documentId, doc }}))
    return [documentId, doc] // erm
  }
  
  load(documentId, automergeDoc) {
    const doc = new RepoDoc(documentId, automergeDoc)
    this.docs[documentId] = doc
    this.dispatchEvent(new CustomEvent('document', { detail: { documentId, doc }}))
    return doc
  }
}
