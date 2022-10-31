# automerge-repo

Folks building automerge-based applications often have similar requirements for storage and networking. While the core of Automerge is designed to allow a user to use or ignore any of its capabilities and plug it into many systems, this class is designed to provide straightforward access to relatively default behaviour for synchronization and storage.

# Usage
```js
import { Repo } from "automerge-repo"
import { LocalForageStorageAdapter } from "automerge-repo-storage-localforage"
import { BroadcastChannelNetworkAdapter } from "automerge-repo-network-broadcastchannel"

const repo = new Repo({
    storage: new LocalForageStorageAdapter(),
    network: [
      new BroadcastChannelNetworkAdapter(),
    ],
})

# now try to load the document from localstorage, or failing that create a new one
# weirdly, this works with synchronization from another source because the other source
# will be able to merge with your fresh, empty document
let handle = repo.find(docId)
if (!handle) { handle = repo.create() }

# get an event every time the document is changed either locally or remotely
# the data is { handle: DocHandle }
doc.on('change', ({ handle, doc }) => render(handle))

# the current API is not great and you've already missed the first change notification by now
# so you're going to have to call your first render() manually.
render(await handle.value())
```

# API & Design Notes

The Repo wires together a few systems.

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
  this.emit('peer', { peerId, channelId, connection }})
  this.emit('message', { peerId, channelId, message /* a UInt8Array containing a SyncMessage */ }})
```

To send messages, call `networkSubsystem.onMessage(peerId, message)`. BrowserRepo wires this all up for you in a simple configuration but you can reconfigure or extend that design if your needs are different.
