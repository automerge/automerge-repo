/* eslint-disable no-undef */
export default class Repo extends EventTarget {
  // can i avoid storing the docs in here?
  docs = {}

  // we should only have one socket per peer
  peers = {}

  storage

  network

  // I don't like how this network stuff isn't nicely segmented into its own tidy place.
  // There should be a separate "network" and "storage" component
  // (storage would handle, for example, compaction)
  syncWithPeers = (documentId, doc) => {
    Object.entries(this.peers).forEach(([peerId, { connection, syncStates }]) => {
      if (!connection.isOpen()) {
        return
      }
      const [syncState, msg] = Automerge.generateSyncMessage(doc, syncStates[documentId])
      this.peers[peerId].syncStates[documentId] = syncState
      if (msg) {
        connection.send(msg)
      }
    })
  }

  constructor(storage, network) {
    super()
    this.storage = storage
    this.network = network

    // when we discover a peer for a document
    // we set up a syncState, then send an initial sync message to them
    const onPeer = ({ peerId, documentId, connection }) => {
      this.peers[peerId] = { connection, syncStates: {} }

      // Start sync by sending a first message.
      // TODO: load syncState from localStorage if available
      const [syncState, msg] = Automerge.generateSyncMessage(
        this.docs[documentId],
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
      let doc = this.docs[documentId];
      
      [doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, message)
      this.peers[peerId].syncStates[documentId] = syncState


      this.dispatchEvent(
        new CustomEvent('change', { detail: { documentId, doc, origin: 'remote' }}),
      )
    }

    this.network.addEventListener('peer', (ev) => onPeer(ev.detail))
    this.network.addEventListener('message', (ev) => onMessage(ev.detail))

    const onChange = ({ documentId, doc }) => {
      this.docs[documentId] = doc
      const binary = Automerge.save(doc)
      this.storage.save(documentId, binary)
      this.syncWithPeers(documentId, doc)
    }
    this.addEventListener('change', (ev) => onChange(ev.detail))
  }

  change(documentId, callback) {
    const doc = Automerge.change(this.docs[documentId], callback)
    this.dispatchEvent(
      new CustomEvent('change', { detail: { documentId, doc, origin: 'local' }}),
    )
    return this.docs[documentId]
  }

  async load(documentId) {
    console.log(this, this.storage)
    const binary = await this.storage.load(documentId)
    if (!binary) return null
    this.network.join(documentId)
    const doc = Automerge.load(binary)

    this.dispatchEvent(
      new CustomEvent('change', { detail: { documentId, doc, origin: 'remote' }}),
    )
    return this.docs[documentId]
  }

  create(documentId) {
    // note, we don't save until the first change
    this.docs[documentId] = Automerge.init()
    this.network.join(documentId)
  }
}
