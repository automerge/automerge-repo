export class NetworkSubsystem {
  networkAdapters = [];
  peers = {};

  // this is obviously wrong
  docs = {};

  constructor(networkAdapters) {
    this.peerId = `user-${Math.round(Math.random() * 1000)}`
    // this really ought to do some input checking
    if (!Array.isArray(networkAdapters)) { networkAdapters = [networkAdapters]}
    this.networkAdapters = networkAdapters;
    networkAdapters.forEach(a => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter) {
    networkAdapter.connect(this.peerId)
    networkAdapter.addEventListener('peer', (ev) => this.onPeer(ev.detail));
    networkAdapter.addEventListener('message', (ev) => this.onMessage(ev.detail));
  }

  // when we discover a peer for a document
  // we set up a syncState, then send an initial sync message to them
  onPeer({ peerId, documentId, connection }) {
    if (!this.peers[peerId]) {
      this.peers[peerId] = { connection, syncStates: {} };
    }

    // Start sync by sending a first message.
    // TODO: load syncState from localStorage if available
    const [syncState, msg] = Automerge.generateSyncMessage(
      this.docs[documentId].value(),
      Automerge.initSyncState()
    );
    this.peers[peerId].syncStates[documentId] = syncState;
    if (msg) {
      this.peers[peerId].connection.send(msg);
    }
  };

  // when we hear from a peer, we receive the syncMessage
  // and then see if we need to reply to them (or anyone else)
  onMessage({ peerId, documentId, message }) {
    let syncState = this.peers[peerId].syncStates[documentId];
    let doc = this.docs[documentId].value();

    [doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, message);
    this.peers[peerId].syncStates[documentId] = syncState;

    this.docs[documentId].replace(doc);
  };
  
  onDocument(e) {
    const { documentId, doc } = e.detail;
    this.docs[documentId] = doc;
    this.networkAdapters.forEach(a => a.join(documentId));
    doc.addEventListener('change', (e) => {
      const { documentId, doc } = e.detail;
      this.syncWithPeers(documentId, doc);
    });
  }

  syncWithPeers = (documentId, doc) => {
    this.peers = Object.entries(this.peers).reduce(
      (nextPeers, [peerId, { connection, syncStates }]) => {
        if (!connection.isOpen()) {
          return nextPeers;
        }
        const [syncState, msg] = Automerge.generateSyncMessage(doc, syncStates[documentId]);
        if (!nextPeers[peerId]) { nextPeers[peerId] = { connection, syncStates }; }
        nextPeers[peerId].syncStates[documentId] = syncState;
        if (msg) {
          connection.send(msg);
        }
        return nextPeers;
      }, {});
  };
}
