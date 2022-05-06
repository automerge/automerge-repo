# automerge-repo

Folks building automerge-based applications often have similar requirements for storage and networking. While the core of Automerge is designed to allow a user to use or ignore any of its capabilities and plug it into many systems, this class is designed to provide straightforward access to relatively default behaviour for synchronization and storage.

# Usage
```js
# Create a repository, passing in a StorageAdapter and NetworkAdapter
const repo = new Repo(StorageAdapter(), new NetworkAdapter('ws://localhost:8080'))

# pick a globally unique UUID specific to this document
# or, you know, just use a hardcoded string and deal with the consequences later
let docId = window.location.hash.replace(/^#/, '') || 'my-todo-list'

# now try to load the document from localstorage, or failing that create a new one
# weirdly, this works with synchronization from another source because the other source
# will be able to merge with your fresh, empty document
# (though not if you start editing it right away. what the hell is wrong with us.)
let doc = await repo.load(docId)
if (!doc) { doc = repo.create(docId) }

# get an event every time the document is changed either locally or remotely
# the data is { documentId: string, doc: Automerge }
doc.addEventListener('change', (ev) => render(ev.detail))

# the current API is not great and you've already missed the first change notification by now
# so you're going to have to call your first render() manually.
render({ doc: doc.value() })
```

# Example

Sample code is provided in `./example`. Run it with `yarn run demo`, then go to [http://localhost:8081/example] to see it running. Note that unless you're already running the local-first-web/relay server on port 8080 it won't work.

# API & Design Notes

The Repo object holds a collection of documents, indexed by UUID.

It makes use of two subsystems (storage and networking) to handle synchronization and persistence of data. Currently there are only one implementation for each of these and neither one is particularly robust or performance-oriented. As this library matures, hopefully that is no longer true.

The interface for a Network Adapter is as follows:
```
  interface LocalFirstRelayNetworkAdapter extends EventTarget {
    join(docId) // to listen for new peers for a given document
  }
  this.dispatchEvent('peer', new CustomEvent { detail: { peerId, documentId, connection }})
  this.dispatchEvent('message', new CustomEvent { detail: { peerId, documentId, message /* a UInt8Array containing a SyncMessage */ }})

  The connection has two methods:
  interface RepoConnection {
    isOpen(): bool // is the connection live and ready to send?
    send(msg): a UInt8Array containing a SyncMessage
  }
```

# Future Work and Known Issues

There are a number of problems with the current design which I will briefly enumerate here:
 * Repo / RepoDoc
  * RepoDoc is a strange class that wraps an underlying Automerge doc. I don't think it's particularly inteligible when you should expect one vs. the underlying data.
  * The EventTarget interface doesn't work in node, and there's no way to send a "welcome" event to a new listener, leading to awkwardness for new subscribers.
  * users shouldn't assign their own hard-coded names. With this model everyone on the same sync hub would collide and clobber each other's 'my-todo-list' object
 * NetworkSubsystem
  * keeps its own set of document references, which is lame and unnecessary.
  * no way of discovering documents as a batch or requesting synchronization for multiple documents.
  * one websocket per peer per document. seems expensive
  * syncstates aren't persisted... but neither are client-ids
 * StorageSubsystem
  * it's gonna get expensive to store whole files on every change
  * storage is shared across all clients in a browser but we don't do anything to dedupe / make that cheaper

In addition there are a bunch of obvious next Adapters to implement. I'd probably want to see a FileSystem store and a BroadcastChannel network. We'll need to support [0-N] storage & network adapters as well. Right now we're hardcoded to one of each.
