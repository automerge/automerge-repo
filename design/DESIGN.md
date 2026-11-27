# Design

This document is an overview of the design of `automerge-repo` v3.

## Introduction

`automerge-repo` is intended to be a toolkit for writing local-first
applications on top of the `automerge` CRDT library. We do this by identifying
documents with a URL and then providing a `Repo`, which brings together
networking and storage to provide a `DocHandle` for any given URL - which is a
reference to a live synchronized automerge document.

Historically the networking and storage components have been tightly coupled to
automerge, `automerge-repo` v3 moves away from this to a more general
sync and storage mechanism based on
[subduction](https://github.com/inkandswitch/subduction).

In fact, this version of `automerge-repo` is an attempt to become much more
modular and pluggable than v2. This reflects two broad goals of the design:

- Enable (optional) end-to-end encryption and access control with
  [keyhive](https://github.com/inkandswitch/keyhive)
- Enable much more experimentation around `automerge-repo` by making the
  architecture more modular

This document will cover first how storage and sync work in automerge v3, and
then how that interacts with the more modular `DocHandle` where we are able
to express a number of integration points that keyhive needs without
specifically depending on keyhive or requiring it.

## Overview

`automerge-repo` v3 replaces the legacy sync and storage subsystems with a
single `SedimentreeBackend` which is a minimal interface for "things which can
sync sedimentrees". This minimal interface allows for integrations to be built
as wrappers around a backend. The `keyhive` integration works by wrapping some
existing backend and adding encryption and decryption to changes passing
through it.

Backends can also add attributes to the `DocHandle`s which are loaded from
them. This allows `keyhive` to add a `.keyhive()` attribute to a `DocHandle`,
but it's also how the built in ephemeral messaging feature is implemented.

Finally, `DocHandle`s can be parameterised by the type of CRDT they represent -
`automerge-repo` can thus be taught to sync non-automerge things.

The overall goal of all these efforts is to make it possible to experiment with
a wider array of APIs and technologis on top of `automerge-repo` without having
to fork it.

## Sync and Storage

Storage and sync are moving out of `automerge-repo` and behind an interface
we call `SedimentreeBackend`. The recommended implementation of this is in
`automerge-repo-subduction` and is based on `subduction`, but it's a simple
interface that should be possible to swap out.

The `SedimentreeBackend` requires just that you have a way of syncing
"sedimentrees".

### Sedimentrees

The primary motivations for moving to a new storage and sync backend are
scalability and privacy. The current sync protocol requires both ends of the
sync process to load up the entire commit graph of the document being synced.
This is resource hungry as large documents take a lot of CPU and memory to
load. It also means that the sync server can't sync encrypted content (at least,
not without sacrificng the bandwidth savings that we get by compressing
metadata).

The solution to both of these problems is to represent a document as a
[sedimentree](https://github.com/inkandswitch/subduction/blob/main/design/sedimentree.md).
Sedimentrees represent a document as chunks of the commit graph which are
produced by clients who have the cleartext and then encrypted for sync servers
to ship around. Sync servers thus do little work and don't need to see the
document contents. We still get the bandwidth reduction of metadata
compression.

### Backends

We are not committing to subduction in particular, just that you are able to
sync sedimentrees. This means that we will be able to in future implement
a backend that syncs sedimentrees with the legacy sync and storage protocols
of `automerge-repo` v2. This is our most likely migration path.

## Modular `DocHandle`s

In `automerge-repo` v2 the `DocHandle` had a generic type parameter on it
representing the shape of the data tha was expected to be inside the
`DocHandle`. In v3 this has changed a little. The `DocHandle` which repo gives
you has two new features:

- It has extension which are attributes added to the dochandle by the backend
- It can represent any document type which implements an interface called
- `DocType`, which roughly speaking is something that knows how to talk
- sedimentree

These two things mean that many features which would have required deep
integration with `automerge-repo` in v2 can be implemented as extensions
provided by a backend in v3. This includes synchronizing non-automerge things.
