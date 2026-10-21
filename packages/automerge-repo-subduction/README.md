# Automerge Repo Subduction backend (experimental)

**Experimental, not production-ready.** Requires exclusively owned storage and
explicitly trusted peers. Requires `@automerge/subduction` with stored-data
streams (`loadAndWatch`; currently the unreleased
`api-review-integration` branch).

## Quick start

```ts
// Node: initialize fullfat WASM before constructing the slim-backed peer.
import "@automerge/subduction"
import { Repo } from "@automerge/automerge-repo"
import { createSubductionPeer } from "@automerge/automerge-repo-subduction"

const peer = createSubductionPeer({ servers: ["ws://127.0.0.1:8080"] })
const repo = new Repo({ backend: peer.backend })
try {
  const handle = await repo.create({ message: "Hello" })
  console.log(peer.peerId, handle.documentId)
  // Keep Repo and peer alive while using this handle.
} finally {
  try {
    await repo.shutdown()
  } finally {
    await peer.close()
  }
}
```

The package imports `@automerge/subduction/slim` and does not initialize WASM.
Browser apps must await the matching native initializer before creating a peer.
By default `createSubductionPeer()` uses an in-memory signer and byte store:
identity and history do not survive restart. Injected signers and stores are
borrowed; keep them alive until after `peer.close()`. Use valid Ed25519 signer
keys, as native code can panic on invalid keys.

### IndexedDB byte store

For persistent local history in a browser, pass `new IndexedDBByteStore()` as
`storage`. It uses the `automerge-repo-subduction` database and `bytes` object
store; pass `{ database, store }` to choose names for another dedicated database.
The chosen store is created only when the database is new. Each `saveBatch` is one
readwrite transaction. A completed save does not guarantee fsync or protection
from browser eviction.

After shutting down Repo and closing the peer, call `await storage.close()` to
release its database connection.

```ts
// Node initializer shown; browsers must await their native WASM initializer.
import "@automerge/subduction"
import { Repo } from "@automerge/automerge-repo"
import {
  createSubductionPeer,
  IndexedDBByteStore,
} from "@automerge/automerge-repo-subduction"

const storage = new IndexedDBByteStore()
const peer = createSubductionPeer({ storage, servers: ["ws://127.0.0.1:8080"] })
const repo = new Repo({ backend: peer.backend })
try {
  // ... use repo ...
} finally {
  try {
    await repo.shutdown()
  } finally {
    try {
      await peer.close()
    } finally {
      await storage.close()
    }
  }
}
```

Inject a persistent signer if peer identity must survive reloads. Use one live
backend per database, including across browser tabs and custom object stores;
concurrent local deletes and writes are not coordinated across tabs.

### Server connections

`servers` accepts WebSocket URL strings, `URL` objects, or `{ url, serviceName? }`.
Configured servers connect immediately; `peer.connect(server)` adds another
connection to `peer.connections`.

Use `connection.connected()` to wait for a connection; it retries by default.
Configure `retry: { initialMs, maxMs }` or `retry: false`, and use
`connection.reconnect()` to retry immediately. `connectTimeoutMilliseconds`
defaults to 10 seconds for opening, authentication and backend onboarding.

`connection.close()` closes only its socket. Call `repo.shutdown()` before
`peer.close()`; call `repo.flush()` first to observe persistence failures.

For an existing backend and signer, use `connectSubductionServer` directly:

```ts
import { connectSubductionServer } from "@automerge/automerge-repo-subduction"

const connection = connectSubductionServer(backend, signer, serverUrl, {
  retry: false,
  connectTimeoutMilliseconds: 10_000,
})
try {
  await connection.connected()
  // Use the existing backend.
} finally {
  await connection.close()
}
```

This borrows both backend and signer; it closes neither.

## Construction and ownership

```ts
// Node: initialize fullfat BEFORE constructing the slim-backed implementation.
import { MemorySigner } from "@automerge/subduction"
import { SubductionBackend } from "@automerge/automerge-repo-subduction"

const signer = MemorySigner.generate()
const backend = new SubductionBackend({
  signer,
  storage: byteStore,
})
// ... use the plain SedimentreeBackend contract ...
await backend.close()
signer.free()
```

Browser apps must initialize native WASM first. The signer is **borrowed**: keep
it alive until close completes, then free it yourself.

The injected `ByteStore` has exactly:

```ts
load(key: string): Promise<Uint8Array | undefined>
loadMany(keys: readonly string[]): Promise<(Uint8Array | undefined)[]>
save(key: string, data: Uint8Array): Promise<void>
saveBatch(entries: [key: string, data: Uint8Array][]): Promise<void>
remove(key: string): Promise<void>
removeBatch(keys: string[]): Promise<void>
removeRange(prefix: string): Promise<void>
list(prefix: string): Promise<string[]> // full keys with this prefix
loadPrefix(prefix: string): Promise<[key: string, data: Uint8Array][]>
```

`loadMany` returns requested values in input order from one consistent read;
paired metadata and blob point lookups must not straddle transactions.
`loadPrefix` returns every entry whose key starts with `prefix`,
as full keys sorted by key, from **one consistent read**: a concurrent `save` or
`remove` must appear entirely before or entirely after it, so `list` followed by
separate `load`s is not equivalent unless nothing else can write meanwhile.
Keys and prefixes are backend-owned ASCII strings.
Returned bytes are owned by the caller. Opening a document is a single
`loadPrefix` call.

`save` **must atomically replace one entire value**. `saveBatch` (required;
custom stores written against the earlier interface must add it) **must make
every entry visible, or none**, including to a concurrent `loadPrefix`. Successful
resolution must mean recoverable under the store's documented guarantees (not
necessarily fsync).
`removeBatch` (required) **must remove every key, or none**, with the same
visibility and resolution guarantees. Missing values are `undefined`; `remove`
and `removeBatch` ignore missing keys. `removeRange` atomically removes every
key with the given prefix, including on an empty prefix. Do not mutate supplied
bytes. The `subduction-v2/` namespace must be exclusively owned by this backend;
the earlier `subduction-v1/` format is not migrated or read.
Storage is borrowed and is not closed or erased by backend close. Concurrent
multi-owner access and hostile storage are unsupported.

## Low-level authenticated peer connections

Pass an already authenticated native transport to `backend.addConnection()`.
For example, on the dialing side (the remote side must concurrently call native
`AuthenticatedTransport.accept()` and add its result to its own backend):

```ts
import { AuthenticatedTransport, PeerId } from "@automerge/subduction"

const expectedPeer = new PeerId(remotePublicKeyBytes)
try {
  const authenticated = await AuthenticatedTransport.setup(
    transport, // native Transport: sendBytes/recvBytes/disconnect/onDisconnect
    signer,
    expectedPeer
  )
  try {
    await backend.addConnection(authenticated)
  } finally {
    authenticated.free()
  }
} catch (error) {
  await transport.disconnect()
  throw error
} finally {
  expectedPeer.free()
}
```

`addConnection` borrows the authenticated wrapper until its promise settles;
keep the underlying JS transport alive until disconnect. Callers own dialing,
handshake cleanup, and reconnection. Native uses **allow-all authorization**;
authenticated identity is not an application sharing policy. Connect only
explicitly trusted peers. A successful synchronization round does **not** prove
remote durability, document readiness, or global convergence.

Only open documents sync a new connection (through their native stream). Stored
but unopened documents are not replayed on connect; native still serves them to
peers that ask. Each local `store()` schedules one coalesced propagation round
to the currently connected peers.

### Empty connected lookups

Opening a document with no local history asks connected peers for it (native
`loadAndWatch`). It keeps observing and syncs peers on future connections and
reconnections, without a peer-loading timeout. An empty local scan with no
connected peers is provisionally unavailable; if peers are connected but none
supplies history, the lookup stays loading. Neither proves global absence.
Local history is returned immediately, then refreshed and subscribed through
the same stream. Deletion ends the document's sessions and removes its history
through native `removeSedimentree`; connections stay open.

### Ephemeral messages

`handle.broadcast(message)` uses best-effort, nonpersistent native pubsub. The
event's `sender` is the signature-verified originator, not the immediate relay;
`message.origin` is untrusted. Encoded envelopes are limited to 64 KiB. Native
Subduction suppresses echoes and relay loops by signed originator and a
per-publish nonce; message IDs cross the wire unchanged and are not used for
deduplication, so publishing one envelope twice delivers it twice. Sending with no connected peers is a no-op. Resolution is not a delivery
acknowledgment; messages have no receipts, retries, or replay after reconnection.

## Persistence and integrity

Each `store()`/`create()` submission, and each batch native sync receives, is
written with one atomic `saveBatch`. Subduction registers tree IDs separately
under `subduction-v2/ids/<tree>`; records live under
`subduction-v2/trees/<tree>/`. A registered tree can have no records. A failed
batch stores none of its records. A save that commits and then rejects is
ambiguous: native rescans storage and redelivers it to open sessions, and an
exact retry dedupes. Repo neither orders nor batches a document's writes: each
edit is submitted at once, concurrently with earlier ones. Failed writes are not
retried: after one, Repo rejects further local edits to that document.
Malformed records fail
rather than appearing absent. Each record uses separate `blob/<id>` and `meta/<id>` keys under
`commits/` or `fragments/`, read together in one transaction; missing halves
fail loudly. Metadata decoding detects malformed signed bytes; native hydration
checks blob digests. Storage is not protected against malicious tampering.
A different representation of an existing commit ID is rejected, as an opaque
`io` error (native does not pass the bridge's typed error through). As in native
Subduction storage, fragments are keyed by head plus payload digest: valid
same-head variants coexist, and a head lookup returns the one native keeps
(lowest payload digest). Repo stores edits as loose commits and their
fragments later (deferred compaction); superseded records are never deleted.

Observers must handle duplicate durable deliveries. A session that falls
behind its replay budget ends with `rescan-required`. `close()` disconnects
peers at once, waits for accepted local stores and deletions, then closes the
native engine (which cancels remaining calls and drains its own tasks,
including ingested writes) and frees it.

Storage is accessed only through Subduction: the bridge implements native's
storage callbacks and nothing else, and the backend keeps no record of write
outcomes.

Until native provides per-tree ordering and a flush barrier, the backend keeps
an interim, self-clearing acknowledgement chain per document over its own
stores: saves run concurrently, but each `store()` resolves only after earlier
stores to that document (and rejects if any of them failed). `deleteLocal`
joins the same chain: it waits for earlier stores before removing the tree, and
stores are rejected until removal settles. `flush()` waits for the stores and
deletions accepted before the call and reports their failures; `close()` waits
for them before closing the engine. No failure is retained: Repo keeps each
document's first write failure and reports it from `repo.flush()`.

### Known gaps

The backend contract asks for behaviour native Subduction does not provide yet.
These are tracked upstream rather than emulated here:

- **Ingested writes.** `flush()` does not wait for writes of peer data, and a
  failed one is not reported to the document's session.
- **Deletion fencing.** Deletion waits for local stores, but not for ingested
  writes in flight, and does not stop peer sync: a subscribed peer can resend
  the tree.
- **Typed write errors.** Native wraps storage rejections in opaque errors, so a
  conflicting representation surfaces as `io`, not `conflict`.

## Limits

Default limits:

| Option                    |                                               Default |
| ------------------------- | ----------------------------------------------------: |
| `syncTimeoutMilliseconds` | 5,000 ms per explicit or store-triggered sync request |
| `replayEvents`            |                                         128 per watch |
| `replayBytes`             |                                       4 MiB per watch |

A write reads only the keys it writes (to detect a conflicting representation
and duplicate notifications); it does not rescan the tree. A
`store()`/`create()` submission of any size is accepted: it is validated up
front (wire counts), then written in one native call; the bridge checks each
record against its own stored key. It is not split: a document must already fit
in Automerge's WASM memory, which is exhausted long before a submission would
strain Subduction's. Neither a single record nor a tree's total history is
capped: whatever was accepted can always be reopened, enumerated, synced and
deleted. Each open session consumes one native stored-data stream: its initial scan is
delivered as a single blob event, so very large trees cost time and heap
proportional to their size rather than being refused. This does not supply a
source-head marker: Repo accepts nonempty document heads after the entire blob
batch has been applied. Later stored items, local or from peers, follow as live
records; recovery scans arrive as further blob events. The replay limits bound
live delivery, not initial blob size, total heap use, session count, or queued
operations. This is not a streaming or production large-history
write path.

## Dependency and tests

From the workspace root:

```sh
pnpm --filter @automerge/automerge-repo build
pnpm --filter @automerge/automerge-repo-subduction build
pnpm exec vitest run --project repo-subduction
pnpm exec tsc -p packages/automerge-repo-subduction/test/tsconfig.json
```
