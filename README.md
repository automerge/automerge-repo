# Automerge-Repo

This repository contains Automerge-Repo, a wrapper for the Automerge CRDT library which provides facilities to support working with many documents at once, as well as pluggable networking and storage.

The core repo, `automerge-repo` handles dispatch of events and provides shared functionality such as deciding which peers to connect to or when to write data out to storage.

There is a React-based demonstration application called `automerge-repo-react-demo` and a synchronization server under `automerge-repo-sync-server`. There are example "hooks" for use with react under `automerge-repo-react-hooks`.

There are a number of additional submodules providing either networking or storage support for various deployment scenarios, including:

 * automerge-repo-storage-localforage - a storage adapter to persist data in a browser
 * automerge-repo-storage-nodefs - a storage adapter to write changes to a unix filesystem
 * automerge-repo-network-websocket - network adapters for both sides of a client/server configuration over websocket
 * automerge-repo-network-localfirst-relay - a network client that uses @localfirst/relay to relay traffic between  peers
 * automerge-repo-network-broadcastchannel - an in-browser / between tabs communication system useful for demos or to keep multiple tabs in sync

All of these are found in `packages`.

## Starting the app

```
$ yarn
$ yarn dev
```

## Acknowledgements

Originally authored by Peter van Hardenberg. Thanks to Herb Caudill and Jeremy Rose for their contributions to this repo.
