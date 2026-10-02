# Automerge Repo

Automerge Repo is a wrapper for the [Automerge](https://github.com/automerge/automerge) CRDT library which provides facilities to support working with many documents at once, as well as pluggable networking and storage.

The core types are in `automerge-repo`. Persistence and synchronization are provided by backends, including `automerge-repo-subduction`. React, Svelte, and Solid bindings wrap the core document APIs. Legacy network/storage adapter packages are no longer included.
