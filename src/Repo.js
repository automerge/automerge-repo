import DocHandle from './DocHandle.js'

export default class Repo extends EventTarget {
  handles = {}
  storageSubsystem

  // TODO: There's a weird asymmetry here where the storage subsystem
  //       wants to be told when a document changes to decide if it should save but the
  //       Repo needs to have direct access to the storage subsystem to load...
  constructor(storageSubsystem) {
    super()
    this.storageSubsystem = storageSubsystem
  }

  async getOrLoad(documentId) {
    return this.handles[documentId] || this.load(documentId)
  }

  async getOrLoadOrRequest(documentId) {
    return this.handles[documentId] || this.loadOrRequest(documentId)
  }

  get(documentId) {
    return this.handles[documentId]
  }

  async load(documentId) {
    const automergeDoc = await this.storageSubsystem.load(documentId)
    const handle = new DocHandle(documentId, automergeDoc)
    this.handles[documentId] = handle
    this.dispatchEvent(new CustomEvent('document', { detail: { handle } }))
    return handle
  }

  // this is idomatically super weird
  async loadOrRequest(documentId) {
    const automergeDoc = await this.storageSubsystem.load(documentId) || Automerge.init()
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
