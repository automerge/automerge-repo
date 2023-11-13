# Automerge Repo

Automerge Repo is a wrapper for the [Automerge](https://github.com/automerge/automerge) CRDT library
which provides facilities to support working with many documents at once, as well as pluggable
networking and storage.

## Getting started

After cloning this repo, run `yarn install` and `yarn build`.

This is a monorepo containing the following packages:

- [automerge-repo](/packages/automerge-repo/): The core library. Handles dispatch of events and
  provides shared functionality such as deciding which peers to connect to or when to write data out
  to storage. Start here.

#### Demos / Example Code

- [automerge-repo-demo-todo](/examples/react-todo/): A React-based to-do list.
- [automerge-repo-demo-counter](/examples/react-counter/): A React-based demonstration
  application.
- [automerge-repo-demo-counter-svelte](/examples/svelte-counter/): A Svelte-based
  example project.
- [sync-server](/examples/sync-server): A very simple sync server which the other examples can use
  - Please note this is different from [automerge-repo-sync-server](https://github.com/automerge/automerge-repo-sync-server)

#### Front-end adapters

- [automerge-repo-react-hooks](/packages/automerge-repo-react-hooks/): Example hooks for use with
  React.
- [automerge-repo-svelte-store](/packages/automerge-repo-svelte-store/): A custom store for use with
  Svelte.

#### Storage adapters

- [automerge-repo-storage-indexeddb](/packages/automerge-repo-storage-indexeddb/): A storage
  adapter to persist data in a browser
- [automerge-repo-storage-nodefs](/packages/automerge-repo-storage-nodefs/): A storage adapter to
  write changes to the filesystem

#### Network adapters

- [automerge-repo-network-websocket](/packages/automerge-repo-network-websocket/): Network adapters
  for both sides of a client/server configuration over websocket
- [automerge-repo-network-messagechannel](/packages/automerge-repo-network-messagechannel/): A
  network adapter that uses the [MessageChannel
  API](https://developer.mozilla.org/en-US/docs/Web/API/MessageChannel) to communicate between tabs
- [automerge-repo-network-broadcastchannel](/packages/automerge-repo-network-broadcastchannel/):
  Likely only useful for experimentation, but allows simple (inefficient) tab-to-tab data
  synchronization

Please note that a reference sync-server peer which demonstrates the use of 
[automerge-repo-network-websocket](/packages/automerge-repo-network-websocket/)
is available at [automerge-repo-sync-server](https://github.com/automerge/automerge-repo-sync-server) (this is different from [sync-server](/examples/sync-server)).
