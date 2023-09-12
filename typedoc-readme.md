# Automerge Repo

Automerge Repo is a wrapper for the [Automerge](https://github.com/automerge/automerge) CRDT library which provides facilities to support working with many documents at once, as well as pluggable networking and storage.

The core types of this library are in the `automerge-repo` package. The various `automerge-repo-network-*` packages contain network adapters for use with various transports whilst the `automerge-repo-storage-*` packages contain storage adapters. Check the documentation of `automerge-repo` for more info about network and storage adapters.
