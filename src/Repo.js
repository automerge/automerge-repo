import { RepoDoc } from "./RepoDoc.js"
import { NetworkSubsystem } from "./network/NetworkSubsystem.js"
import { StorageSubsystem } from "./storage/StorageSubsystem.js"

export default class Repo extends EventTarget {
  docs = {}
  storageSubsystem
  networkSubsystem

  constructor(storageInterface, networkInterface) {
    super()
    this.storageSubsystem = new StorageSubsystem(storageInterface)
    this.networkSubsystem = new NetworkSubsystem(networkInterface)
    this.addEventListener('document', (e) => this.storageSubsystem.onDocument(e))
    this.addEventListener('document', (e) => this.networkSubsystem.onDocument(e))
  }
  
  create(documentId) {
    const doc = new RepoDoc(documentId, Automerge.init())
    this.docs[documentId] = doc
    this.dispatchEvent(new CustomEvent('document', { detail: { documentId, doc }}))
    return doc
  }
  
  async load(documentId) {
    const doc = new RepoDoc(documentId, await this.storageSubsystem.load(documentId))
    this.docs[documentId] = doc
    this.dispatchEvent(new CustomEvent('document', { detail: { documentId, doc }}))
    return doc
  }
}
