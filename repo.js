/* eslint-disable no-undef */
class Doc extends EventTarget {
  doc

  constructor(documentId, doc) {
    super()
    this.documentId = documentId
    this.doc = doc
  }

  change(callback) {
    const doc = Automerge.change(this.doc, callback)
    this.replace(doc)
  }

  replace(doc) {
    this.doc = doc
    const documentId = this.documentId
    this.dispatchEvent(
      new CustomEvent('change', { detail: { documentId, doc, origin: 'remote' }}),
    )
  }

  value() {
    return this.doc
  }
}

export default class Repo extends EventTarget {
  docs = {}
  peers = {}
  storage
  network

  syncWithPeers = (documentId, doc) => {
    this.peers = Object.entries(this.peers).reduce(
      (nextPeers, [peerId, { connection, syncStates }]) => {
        if (!connection.isOpen()) {
          return nextPeers
        }
        const [syncState, msg] = Automerge.generateSyncMessage(doc, syncStates[documentId])
        if (!nextPeers[peerId]) { nextPeers[peerId] = { connection, syncStates }}
        nextPeers[peerId].syncStates[documentId] = syncState
        if (msg) {
          connection.send(msg)
        }
        return nextPeers
    }, {})
  }

  constructor(storage, network) {
    super()
    this.storage = storage
    this.network = network

    // when we discover a peer for a document
    // we set up a syncState, then send an initial sync message to them
    const onPeer = ({ peerId, documentId, connection }) => {
      if (!this.peers[peerId]) {
        this.peers[peerId] = { connection, syncStates: {} }
      }

      // Start sync by sending a first message.
      // TODO: load syncState from localStorage if available
      const [syncState, msg] = Automerge.generateSyncMessage(
        this.docs[documentId].value(),
        Automerge.initSyncState(),
      )
      this.peers[peerId].syncStates[documentId] = syncState
      if (msg) {
        connection.send(msg)
      }
    }

    // when we hear from a peer, we receive the syncMessage
    // and then see if we need to reply to them (or anyone else)
    const onMessage = ({ peerId, documentId, message }) => {
      
      let syncState = this.peers[peerId].syncStates[documentId]
      let doc = this.docs[documentId].value();
      
      [doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, message)
      this.peers[peerId].syncStates[documentId] = syncState

      this.docs[documentId].replace(doc)
    }

    this.network.addEventListener('peer', (ev) => onPeer(ev.detail))
    this.network.addEventListener('message', (ev) => onMessage(ev.detail))
  }
  
  onChange({documentId, doc}) {
    // this is obviously inefficient and we should do incremental save 
    // and/or occasional compaction
    const binary = Automerge.save(doc)
    this.storage.save(documentId, binary)
    this.syncWithPeers(documentId, doc)
  }

  create(documentId) {
    // note, we don't save until the first change
    this.docs[documentId] = new Doc(documentId, Automerge.init())
    this.docs[documentId].addEventListener('change', (ev) => this.onChange(ev.detail))
    this.network.join(documentId)
  }
  
  async load(documentId) {
    console.log(this, this.storage)
    const binary = await this.storage.load(documentId)
    if (!binary) return null
    this.network.join(documentId)
    const doc = Automerge.load(binary)

    this.docs[documentId] = new Doc(documentId, doc)
    this.docs[documentId].addEventListener('change', (ev) => this.onChange(ev.detail))
    // this is wrong, we should return some kind of wrapped document
    return this.docs[documentId]
  }
}
