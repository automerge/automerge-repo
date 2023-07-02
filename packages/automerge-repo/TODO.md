## TODO

cursor sharing (multi channel?)
repo should be a class

---

peer authentication
E2E encryption
write more tests
file-handle based storage

// TODO:
// efficient sharing of sets of documents

# Future Work and Known Issues

There are a number of problems with the current design which I will briefly enumerate here:

- NetworkSubsystem
- peer candidate selection -> do we trust this peer? (see Network.js peer-candidate)
- handle disconnections -> try another protocol
- syncstates aren't persisted... but neither are client-ids. should they be?

- StorageSubsystem
- customizable save intervals / manual-only saving
- separate backends for incremental vs. full document saves
- S3/redis store for a node storage peer

- Repo Design Problems
- sending cursors / ephemeral data
- we should decide what to sync with a peer based on the peer, not just the docId
- no way of discovering documents as a batch or requesting synchronization for multiple documents.

- SyncProtocol work
- multi-document syncprotocol
- non-peer-specific broadcast SyncMessages
- syncing large repos without having to do expensive loads into memory
- how to decide what documents to sync with a peer
- one-way sync support -> i want to receive but not send changes
- peer-oriented instead of document-oriented sync
- encrypt contents but not structure, allowing syncing with a semi-trusted peer instead of all the peers
  - change.hash & change.deps but with a consistently salted hash?
- RLE encode block of changes

- Synchronizer & network needs improved handling of disconnection & reconnection of peers
- TODO: preserving syncState in localStorage would be a good optimization
  StorageSubsystem:
  // TODO: can we do incremental save that takes advantage of the last binary?
  /\* TODO: we probably want to be able to distinguish between
- incremental & compacted writes due to cost & frequency -> give the option for two storage engines
- we probably also want to have compaction callbacks. count / timeout / manual calls...
  \*/
- figure out a compaction callback system (and an option for explicit saves only)
