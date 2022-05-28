# automerge-repo

Folks building automerge-based applications often have similar requirements for storage and networking. While the core of Automerge is designed to allow a user to use or ignore any of its capabilities and plug it into many systems, this class is designed to provide straightforward access to relatively default behaviour for synchronization and storage.

# Usage
```js
import {
  BrowserRepo, 
  LocalForageStorageAdapter,
  BroadcastChannelNetworkAdapter,
  LocalFirstRelayNetworkAdapter
 } from 'automerge-repo'

const repo = BrowserRepo({
  storage: new LocalForageStorageAdapter(),
  network: [
    new BroadcastChannelNetworkAdapter(),
    new LocalFirstRelayNetworkAdapter('ws://localhost:8080')
  ]
})

# now try to load the document from localstorage, or failing that create a new one
# weirdly, this works with synchronization from another source because the other source
# will be able to merge with your fresh, empty document
# TODO: need to figure out what to do with missing documents / during sync
let handle = await repo.find(docId)
if (!handle) { handle = repo.create(docId) }

# get an event every time the document is changed either locally or remotely
# the data is { handle: DocHandle }
doc.on('change', ({ handle, doc, lastChange }) => render(handle))

# the current API is not great and you've already missed the first change notification by now
# so you're going to have to call your first render() manually.
render(handle)
```

# Example

The example code isn't working right now, but this React code is... probably.

https://github.com/pvh/automerge-repo-react

# API & Design Notes

The BrowserRepo wires together a few systems.

First, the Repo object holds a collection of documents, indexed by documentId (UUID). It returns DocHandles, which hold a doc and its ID together and allow you to listen to changes. There's only one DocHandle in the universe per document in order to ensure event propagation works. This is not a great design feature.

The Repo emits "document" events when it loads / creates / fetches a document for the first time since starting up. The document event has a handle on it. The handles emit "change" events whenever they are mutated whether by local edits through calling handle.change((doc) => { /* do stuff */ }), or by receiving SyncMessages from other peers with the same document.

The Storage System only has a single plugin implemented so far, localforage, which provides a localStorage-like API over IndexedDB. It stores incremental changes and only calls the full .save() every third edit. This should be customizable and also we should expose explicit control over saving to the developer.

The Network discovers peers and routes messages to and from them on (currently) a single discovery channel. The current implementation of the CollectionSynchronizer will offer every open document and accept every document offered to it. This is not ideal but works for a demo and exercises multi-document support and routing.

The network doesn't know anything about Automerge, really. It dispatches messages to the CollectionSynchronizer which instantiates a DocSynchronizer to do the actual synchronization work.

The storage system and network system both support plugging in additional implementations.

The interface for a Network Adapter is as follows:

```js
  interface LocalFirstRelayNetworkAdapter extends EventEmitter3 {
    join(docId) // to listen for new peers for a given document
  }
  this.emit('peer', { peerId, channel, connection }})
  this.emit('message', { peerId, channel, message /* a UInt8Array containing a SyncMessage */ }})
```

To send messages, call `networkSubsystem.onMessage(peerId, message)`. BrowserRepo wires this all up for you in a simple configuration but you can reconfigure or extend that design if your needs are different.

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
