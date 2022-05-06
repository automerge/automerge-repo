export class NetworkSubsystem {
  networkAdapter;
  peers = {};

  // this is obviously wrong
  docs = {};

  constructor(networkAdapter) {
    this.networkAdapter = networkAdapter;
    // when we discover a peer for a document
    // we set up a syncState, then send an initial sync message to them
    const onPeer = ({ peerId, documentId, connection }) => {
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
        connection.send(msg);
      }
    };

    // when we hear from a peer, we receive the syncMessage
    // and then see if we need to reply to them (or anyone else)
    const onMessage = ({ peerId, documentId, message }) => {
      let syncState = this.peers[peerId].syncStates[documentId];
      let doc = this.docs[documentId].value();

      [doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, message);
      this.peers[peerId].syncStates[documentId] = syncState;

      this.docs[documentId].replace(doc);
    };

    this.networkAdapter.addEventListener('peer', (ev) => onPeer(ev.detail));
    this.networkAdapter.addEventListener('message', (ev) => onMessage(ev.detail));
  }

  onDocument(e) {
    const { documentId, doc } = e.detail;
    this.docs[documentId] = doc;
    this.networkAdapter.join(documentId);
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
