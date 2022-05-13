import DocHandle from './DocHandle.js'

export default class Repo extends EventTarget {
  handles = {}

  get(documentId) {
    return this.handles[documentId]
  }

  load(documentId, automergeDoc) {
    const handle = new DocHandle(documentId, automergeDoc)
    this.handles[documentId] = handle
    this.dispatchEvent(new CustomEvent('document', { detail: { handle } }))
    return handle
  }

  create() {
    const documentId = crypto.randomUUID()
    const handle = new DocHandle(documentId, Automerge.init())
    this.handles[documentId] = handle
    this.dispatchEvent(new CustomEvent('document', { detail: { handle } }))
    return [documentId, handle] // erm
  }
}
