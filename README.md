# Automerge Repo

Automerge Repo is a wrapper for the [Automerge](https://github.com/automerge/automerge) CRDT library
which provides facilities to support working with many documents at once, as well as pluggable
networking and storage.

This is a monorepo containing the following packages:

- [automerge-repo](/packages/automerge-repo/): The core library. Handles dispatch of events and
  provides shared functionality such as deciding which peers to connect to or when to write data out
  to storage. **This repository includes a Getting Started tutorial!**
- [automerge-repo-demo-counter](/packages/automerge-repo-demo-counter/): A React-based demonstration
  application.
- [automerge-repo-react-hooks](/packages/automerge-repo-react-hooks/): Example hooks for use with
  React.
- [automerge-repo-sync-server](/packages/automerge-repo-sync-server/): A small synchronization
  server that facilitates asynchronous communication between peers

#### Storage adapters

- [automerge-repo-storage-localforage](/packages/automerge-repo-storage-localforage/): A storage
  adapter to persist data in a browser
- [automerge-repo-storage-nodefs](/packages/automerge-repo-storage-nodefs/): A storage adapter to
  write changes to the filesystem

#### Network adapters

- [automerge-repo-network-websocket](/packages/automerge-repo-network-websocket/): Network adapters
  for both sides of a client/server configuration over websocket
- [automerge-repo-network-localfirstrelay](/packages/automerge-repo-network-localfirstrelay/): A
  network client that uses [@localfirst/relay](https://github.com/local-first-web/relay) to relay
  traffic between peers
- [automerge-repo-network-messagechannel](/packages/automerge-repo-network-messagechannel/): A
  network adapter that uses the [MessageChannel
  API](https://developer.mozilla.org/en-US/docs/Web/API/MessageChannel) to communicate between tabs
- [automerge-repo-network-broadcastchannel](/packages/automerge-repo-network-broadcastchannel/):
  Likely only useful for experimentation, but allows simple (inefficient) tab-to-tab data
  synchronization
