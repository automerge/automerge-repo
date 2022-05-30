TODO
-----
remove Client.js vendored dependency
remove automerge-js & wasm vendored dependencies
get this thing syncing over the real internet
get a text editor wodged in there
get automerge-wasm hooked up in the repo module
cursor sharing (multi channel?)

----------
peer authentication
write a cloud peer to sync with instead of the current design
E2E encryption
write more tests
file-handle based storage

// TODO:
// end-to-end encryption (authenticating peers)
// "drafts" of documents per upwelling (offers)
// PSI -> sharing documents you have in common with a peer
// "offers" so storage peers will save your stuff
// persistent share lists for storage peer

# Future Work and Known Issues

There are a number of problems with the current design which I will briefly enumerate here:
 * Repo / DocHandle
  * DocHandle is a strange class that wraps an underlying Automerge doc. I don't think it's particularly inteligible when you should expect one vs. the underlying data.
  * The EventEmitter3 interface doesn't work in node, and there's no way to send a "welcome" event to a new listener, leading to awkwardness for new subscribers.
 * NetworkSubsystem
  * peer candidate selection -> do we trust this peer?
  * handle disconnections -> try another protocol
  * one websocket per peer per document. seems expensive
  * syncstates aren't persisted... but neither are client-ids
 * StorageSubsystem
  * we could write to IndexedDB on a SharedWorker so we're not duplicating work per-tab
  * customizable save intervals / manual-only saving
  * separate backends for incremental vs. full document saves
  * need a FileSystem store as well, and maybe S3/redis for a node storage peer 

Also, the upstream `@local-first-web/relay` repo doesn't actually support sending binary data over the wire correctly. I'm running a hacked up version and have vendored a hacked-up client into this repo. I should fix both of those problems as well.

* Repo Design Problems
 * sending cursors / ephemeral data
 * we should decide what to sync with a peer based on the peer, not the docId
 * no way of discovering documents as a batch or requesting synchronization for multiple documents.

* SyncProtocol work
 * multi-document syncprotocol
 * non-peer-specific broadcast SyncMessages
 * syncing large repos without having to do expensive loads into memory
 * how to decide what documents to sync with a peer
 * one-way sync support -> i want to receive but not send changes
 * peer-oriented instead of document-oriented sync
 * encrypt contents but not structure, allowing syncing with a semi-trusted peer instead of all the peers
    * change.hash & change.deps but with a consistently salted hash?
 * RLE encode block of changes
