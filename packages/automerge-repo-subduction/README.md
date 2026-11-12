# Automerge Repo Subduction backend

A [Sedimentree backend](../automerge-repo/src/sedimentree/README.md) for Automerge Repo,
built on [Subduction](https://github.com/inkandswitch/subduction)

> **Alpha.** This is not yet ready for use in production

## Quick start

```ts
import { createMemorySigner } from "@automerge/subduction"
import { SubductionBackend } from "@automerge/automerge-repo-subduction"
import { WebSocketSubductionNetworkAdapter } from "@automerge/automerge-repo-subduction-network-websocket"
import { DummySubductionStorageAdapter } from "@automerge/automerge-repo-subduction/helpers/DummySubductionStorageAdapter.js"

const backend = new SubductionBackend({
  storage: new DummySubductionStorageAdapter(),
  // Optional:
  network: [new WebSocketSubductionNetworkAdapter("ws://127.0.0.1:8080")],
  signer: createMemorySigner(), // default: new in-memory identity
  syncTimeoutMilliseconds: 30_000, // default: Subduction's own
  // mintDocumentId: async initialRecords => id, // see Document IDs
  // syncPolicy: (documentId, peerId) => syncRule(syncAll), // see Sync policy
})
```

Pass `backend` to `new Repo({ backend })`; see the
[automerge-repo quick start](../automerge-repo/README.md#quick-start).

## Options

| Option                    | Default                     | Notes                                                                    |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------ |
| `storage`                 | required                    | A [storage adapter](#storage-adapters).                                  |
| `network`                 | `[]`                        | [Network adapters](#network-adapters). Owned by the backend.             |
| `signer`                  | new in-memory identity      | Signs records and handshakes. `backend.peerId` is its hex verifying key. |
| `syncTimeoutMilliseconds` | Subduction's default (30 s) | Deadline for sync requests.                                              |
| `mintDocumentId`          | 16 random + 16 zero bytes   | Mints the ID for `create()`. See [Document IDs](#document-ids).          |
| `syncPolicy`              | everything syncs            | Which documents sync with which peers. See [Sync policy](#sync-policy).  |

## Lifecycle

- Initialize Subduction's WASM first. The package imports `@automerge/subduction/slim` and
  never initializes it
- The backend starts its network adapters at construction and stops them in `close()`.
- The in-memory signer and `DummySubductionStorageAdapter` do not survive restart. Inject a
  persistent signer if peer identity must.
- Shut down in order: `repo.shutdown()`, `backend.close()`, then `storage.close()`.

## Storage adapters

- [automerge-repo-subduction-storage-indexeddb](../automerge-repo-subduction-storage-indexeddb/):
  browser storage
- `DummySubductionStorageAdapter` (`helpers/` subpath): in-memory, for tests and throwaway peers.

An adapter implements `SubductionStorageAdapterInterface`:

## Network adapters

- [automerge-repo-subduction-network-websocket](../automerge-repo-subduction-network-websocket/):
  WebSocket client (also re-exported by `@automerge/react`).

An adapter implements `SubductionNetworkAdapterInterface`. It only supplies byte transports;
Subduction authenticates them and drives all traffic.

## Document IDs

- IDs are 32 bytes
- By default `create()` mints 16 random bytes followed by 16 zero bytes
- Use `mintDocumentId` for anything else:

```ts
const backend = new SubductionBackend({
  storage,
  mintDocumentId: async initialRecords =>
    createBespokeDocumentId(initialRecords),
})
```

## Sync policy

- `syncPolicy(documentId, peerId)` returns a signal of `{ access, announce }`, or a promise
  of one. `documentId` is the hex sedimentree ID; `peerId` is a hex key, like `backend.peerId`
- `access: false`: nothing about the document moves either way, ephemeral messages included
- `announce: false`: we don't start rounds with the peer, but still answer it and push to it
  once it has asked

### Usage

```ts
// syncRule() is a utility that returns a settable signal; any { value, subscribe } works
const rule = syncRule({ access: false, announce: false })
const backend = new SubductionBackend({ storage, syncPolicy: () => rule })
rule.set(syncAll) // e.g. on login
```

## Ephemeral messages

Every handle of a Repo on this backend has ephemeral messaging:

```ts
const repo = new Repo({ backend })
const handle = await repo.find(url)
handle.on("ephemeral-message", ({ senderId, originId, message }) => {})
handle.broadcast({ cursor: 3 })
```

The handle's type is `ExtendedHandle<T, "ephemeral">`, and it meets core's `PresenceHandle`
contract, so it works with `Presence` and the presence hooks.

- Best-effort and not stored.
- `sender` is the peer ID of the backend that signed the message, even when it arrives via a
  relay. `origin` is set by the originator (usually Repo, here) and is not verified.
- Encoded messages are limited to 64 KiB.
- Publishing the same message twice delivers it twice.
