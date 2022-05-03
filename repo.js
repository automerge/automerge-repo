export default class Repo extends EventTarget {
  // can i avoid storing the docs in here?
  docs = {};

  // we should only have one socket per peer
  peers = {};

  storage;
  network;

  // I don't like how this network stuff isn't nicely segmented into its own tidy place.
  // There should be a separate "network" and "storage" component (storage would handle, for example, compaction)
  syncWithPeers = (docId, doc) => {
    Object.values(this.peers).forEach(({ connection, syncStates }) => {
      if (!connection.isOpen()) {
        return;
      }
      let msg;
      let syncState = syncStates[docId];
      [syncState, msg] = Automerge.generateSyncMessage(doc, syncState);
      syncStates[docId] = syncState; // this is an object reference, so works as "expected"
      if (msg) {
        connection.send(msg);
      }
    });
  };

  constructor(storage, network, url) {
    super();
    this.storage = storage;
    this.network = network;

    // when we discover a peer for a document
    // we set up a syncState, then send an initial sync message to them
    const onPeer = (peerId, docId, connection) => {
      let syncState, msg;
      this.peers[peerId] = { connection, syncStates: {} };

      // Start sync by sending a first message.
      // TODO: load syncState from localStorage if available
      [syncState, msg] = Automerge.generateSyncMessage(
        this.docs[docId],
        Automerge.initSyncState()
      );
      this.peers[peerId].syncStates[docId] = syncState;
      if (msg) {
        connection.send(msg);
      }
    };

    // when we hear from a peer, we receive the syncMessage
    // and then see if we need to reply to them (or anyone else)
    const onMessage = (peerId, docId, message) => {
      let syncState = this.peers[peerId].syncStates[docId];
      let doc = this.docs[docId];
      [doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, message);
      this.peers[peerId].syncStates[docId] = syncState;
      this.docs[docId] = doc;
      this.syncWithPeers(docId, doc);
      this.dispatchEvent(
        new CustomEvent("change", { detail: { docId, doc }, origin: "remote" })
      );
    };

    const { join } = network(url, onPeer, onMessage);
    this.join = join;
  }

  save(docId, doc) {
    const binary = Automerge.save(doc);
    this.storage.save(docId, binary);
  }

  change(docId, callback) {
    const doc = Automerge.change(this.docs[docId], callback);
    this.docs[docId] = doc;
    this.save(docId, doc);
    this.syncWithPeers(docId, doc);
    this.dispatchEvent(
      new CustomEvent("change", { detail: { docId, doc }, origin: "local" })
    );
    return this.docs[docId];
  }

  async load(docId) {
    console.log(this, this.storage);
    const binary = await this.storage.load(docId);
    this.join(docId);
    if (!binary) return null;
    this.docs[docId] = Automerge.load(binary);
    return this.docs[docId];
  }

  create(docId) {
    // note, we don't save until the first change
    this.docs[docId] = Automerge.init();
    this.join(docId);
  }
}
