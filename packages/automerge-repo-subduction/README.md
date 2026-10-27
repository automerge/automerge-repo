# Automerge Repo Subduction backend (experimental)

**Experimental, not production-ready.** Requires exclusively owned storage and
explicitly trusted peers. Requires `@automerge/subduction` 0.25.0 with
stored-data streams (`loadAndWatch`) and the plain-object API (currently
unreleased).

## Quick start

```ts
// Node: initialize fullfat WASM before constructing the slim-backed backend.
import "@automerge/subduction"
import { Repo } from "@automerge/automerge-repo"
import { SubductionBackend } from "@automerge/automerge-repo-subduction"
import { WebSocketSubductionNetworkAdapter } from "@automerge/automerge-repo-subduction-network-websocket"
import { DummySubductionStorageAdapter } from "@automerge/automerge-repo-subduction/helpers/DummySubductionStorageAdapter.js"

const backend = new SubductionBackend({
  storage: new DummySubductionStorageAdapter(),
  network: [new WebSocketSubductionNetworkAdapter("ws://127.0.0.1:8080")],
})
const repo = new Repo({ backend })
try {
  const handle = await repo.create({ message: "Hello" })
  console.log(backend.peerId, handle.documentId)
  // Keep Repo and backend alive while using this handle.
} finally {
  try {
    await repo.shutdown()
  } finally {
    await backend.close()
  }
}
```

The package imports `@automerge/subduction/slim` and does not initialize WASM.
Browser apps must await the matching native initializer before creating a
backend. `storage` is required: pass a `SubductionStorageAdapterInterface`. The
in-memory `DummySubductionStorageAdapter` (from the `helpers/` subpath) is for
tests and throwaway peers; nothing survives restart. Without a `signer`, the
backend generates an in-memory identity, which also does not survive restart;
`backend.peerId` is its hex verifying key. Injected signers and storage adapters
are borrowed; keep them alive until after `backend.close()`. Use valid Ed25519
signer keys, as native code can panic on invalid keys.

### Document IDs

Document IDs are 32 bytes. Older 16-byte Automerge URLs are still accepted and
open the same document as their 32-byte form, which `handle.url` reports.
By default `create()` mints IDs a keyhive-enabled Subduction server accepts
without authorization.

To use keyhive authorization instead, mint each ID as the verifying key of a
keyhive document the server knows. Pass a `mintDocumentId` function, which
receives the initial records (e.g. to call keyhive's `generate_doc` with their
heads), to the backend or to `Repo` (where it overrides the backend's):

```ts
const backend = new SubductionBackend({
  storage,
  mintDocumentId: async initialRecords => createKeyhiveDocument(initialRecords),
})
```

If `mintDocumentId` throws or returns anything other than 32 bytes, `create()`
rejects with `BackendError("create", "invalid-id")`.

### Storage adapters

Storage adapters live in separate packages. For persistent local history in a
browser, use `IndexedDBSubductionStorageAdapter` from
`@automerge/automerge-repo-subduction-storage-indexeddb` (also re-exported by
`@automerge/react`):

```ts
// Node initializer shown; browsers must await their native WASM initializer.
import "@automerge/subduction"
import { Repo } from "@automerge/automerge-repo"
import { SubductionBackend } from "@automerge/automerge-repo-subduction"
import { WebSocketSubductionNetworkAdapter } from "@automerge/automerge-repo-subduction-network-websocket"
import { IndexedDBSubductionStorageAdapter } from "@automerge/automerge-repo-subduction-storage-indexeddb"

const storage = new IndexedDBSubductionStorageAdapter()
const backend = new SubductionBackend({
  storage,
  network: [new WebSocketSubductionNetworkAdapter("ws://127.0.0.1:8080")],
})
const repo = new Repo({ backend })
try {
  // ... use repo ...
} finally {
  try {
    await repo.shutdown()
  } finally {
    try {
      await backend.close()
    } finally {
      await storage.close()
    }
  }
}
```

An adapter package implements `SubductionStorageAdapterInterface` (below) and
runs the shared acceptance suite, `runSubductionStorageAdapterTests`, from
`@automerge/automerge-repo-subduction/helpers/tests/subduction-storage-adapter-tests.js`.

Inject a persistent signer if peer identity must survive reloads. Use one live
backend per storage, including across browser tabs; concurrent local deletes
and writes are not coordinated across tabs.

### Network adapters

Network adapters also live in separate packages; the WebSocket client is
`WebSocketSubductionNetworkAdapter` from
`@automerge/automerge-repo-subduction-network-websocket` (also re-exported by
`@automerge/react`). Pass them as `network`; the backend owns them, starting
each at construction and stopping it in `close()`.

An adapter implements `SubductionNetworkAdapterInterface`:

```ts
type SubductionConnect = (
  transport: Transport,
  audience: TransportAudience
) => Promise<string>

start(connect: SubductionConnect): Promise<void>
stop(): Promise<void>
```

Adapters only supply framed byte transports; they never handle messages. Each
transport is passed to `connect`, which authenticates it with the backend's
signer and registers it, after which Subduction drives all traffic over it.
`start` keeps connecting (including reconnection) and settles once the first
attempt has: it resolves when connected and rejects when that attempt failed.
`stop` stops retries, cancels attempts and closes the adapter's transports,
resolving once cleanup is complete. Adapters run the shared acceptance suite,
`runSubductionNetworkAdapterTests`, from
`@automerge/automerge-repo-subduction/helpers/tests/subduction-network-adapter-tests.js`.

A lookup that finds nothing locally waits until every adapter's first attempt
has settled before asking connected peers, so a document is not reported
unavailable while its server is still connecting. Later reconnections do not
delay lookups. An adapter whose first attempt stalls holds such lookups until
it settles or the backend closes.

## Construction and ownership

```ts
// Node: initialize fullfat BEFORE constructing the slim-backed implementation.
import { createMemorySigner } from "@automerge/subduction"
import { SubductionBackend } from "@automerge/automerge-repo-subduction"

const backend = new SubductionBackend({
  signer: createMemorySigner(), // optional
  storage: byteStore,
  network: [], // optional; owned by the backend
})
// ... use the plain SedimentreeBackend contract ...
await backend.close()
```

Browser apps must initialize native WASM first. The signer is **borrowed**: keep
it alive until close completes. It signs records and connection handshakes; a
signer that rejects or returns a malformed signature panics native code, and a
stalled one stalls the handshake past cancellation.

The injected storage adapter implements `SubductionStorageAdapterInterface`:

```ts
loadMany(keys: readonly string[]): Promise<(Uint8Array | undefined)[]>
loadPrefix(prefix: string): Promise<[key: string, data: Uint8Array][]>
list(prefix: string): Promise<string[]> // full keys with this prefix
saveBatch(entries: readonly [key: string, data: Uint8Array][]): Promise<void>
removeBatch(keys: readonly string[]): Promise<void>
removeRange(prefix: string): Promise<void>
```

Single-key operations are one-entry batches. `loadMany` returns requested
values in input order from one consistent read (missing values are
`undefined`); paired signed and blob point lookups must not straddle
transactions. `loadPrefix` returns every entry whose key starts with `prefix`,
as full keys sorted by key, from **one consistent read**: a concurrent
`saveBatch` or `removeBatch` must appear entirely before or entirely after it,
so `list` followed by separate `loadMany`s is not equivalent unless nothing
else can write meanwhile. Keys and prefixes are backend-owned ASCII strings.
Returned bytes are owned by the caller. Opening a document is a single
`loadPrefix` call.

`saveBatch` **must make every entry visible, or none**, each replacing its key,
including to a concurrent `loadPrefix`. Successful resolution must mean
recoverable under the adapter's documented guarantees (not necessarily fsync).
`removeBatch` **must remove every key, or none**, with the same visibility and
resolution guarantees, ignoring missing keys. `removeRange` atomically removes
every key with the given prefix, including on an empty prefix. Do not mutate
supplied bytes. The `subduction-v2/` namespace must be exclusively owned by this backend;
the earlier `subduction-v1/` format is not migrated or read.
Storage is borrowed and is not closed or erased by backend close. Concurrent
multi-owner access and hostile storage are unsupported.

## Low-level peer connections

Pass a framed byte transport (`sendBytes`/`recvBytes`/`disconnect`/`onDisconnect`)
to `backend.addConnection(transport, audience)` on the dialing side and
`backend.acceptConnection(transport, audience)` on the accepting side. Native
authenticates it with the backend's signer; `audience` is either
`{ expectedPeerId }` (the remote peer's hex ID) or `{ serviceName }` for
discovery. Both resolve to the remote peer ID.

```ts
try {
  await backend.addConnection(transport, { expectedPeerId: remotePeerId })
} catch (error) {
  await transport.disconnect()
  throw error
}
```

Keep the JS transport alive until disconnect; disconnecting it cancels a pending
handshake. Callers own dialing, cleanup on failure, and reconnection. Native
uses **allow-all authorization**; authenticated identity is not an application
sharing policy. Connect only explicitly trusted peers. A successful
synchronization round does **not** prove remote durability, document
readiness, or global convergence.

Only open documents sync a new connection (through their native stream). Stored
but unopened documents are not replayed on connect; native still serves them to
peers that ask. Local writes propagate without waiting for peers:

| Write                             | Native call   | Propagation                                             |
| --------------------------------- | ------------- | ------------------------------------------------------- |
| One commit to an existing tree    | `addCommit`   | pushed to subscribed peers                              |
| One fragment to an existing tree  | `addFragment` | pushed to subscribed peers                              |
| Several records (imports, merges) | `storeBatch`  | one sync round per batch                                |
| `create()`                        | `storeBatch`  | one sync round; the session's first round also syncs it |

A subscribing round subscribes both peers, so pushes flow either way. Rounds are
not coalesced: batches stored in quick succession each start one.

### Empty connected lookups

Opening a document with no local history waits for each network adapter's
first attempt to settle, then asks connected peers for it (native
`loadAndWatch`). It keeps observing and syncs peers on future connections and
reconnections, without a peer-loading timeout. An empty local scan with no
connected peers is provisionally unavailable, as is one where an explicit round
with the connected peers supplies no history. Neither proves global absence.
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

The storage bridge stores exactly what Subduction sends and trusts it: it does
not decode, validate or read before writing. Subduction verifies records on
admission and, on load, checks each blob against its signed metadata.

Each `store()`/`create()` submission, and each batch native sync receives, is
written with one atomic `saveBatch`. Subduction registers tree IDs separately
under `subduction-v2/ids/<tree>` (empty values); records live under
`subduction-v2/trees/<tree>/{commits|fragments}/{signed|blob}/<head>`, one
signed/blob key pair per record, read together in one transaction; a missing
half fails loudly. A registered tree can have no records. A failed batch stores
none of its records. A save that commits and then rejects is ambiguous: native
rescans storage and redelivers it to open sessions, and an exact retry rewrites
the same keys. Repo neither orders nor batches a document's writes: each edit
is submitted at once, concurrently with earlier ones. Failed writes are not
retried: after one, Repo rejects further local edits to that document.
Malformed records fail rather than appearing absent. Storage is not protected
against malicious tampering.

A record saved under an existing key overwrites it. Fragments are keyed by head
only, as in Subduction's built-in storage: of two valid same-head variants, the
last written is kept. Repo stores edits as loose commits and their fragments
later (deferred compaction); superseded records are never deleted.

Observers must handle duplicate durable deliveries. Live events queue per
session until pulled. A native stream error after the initial load ends the
session with a terminal `failure`. `close()` disconnects
peers and stops network adapters at once, waits for accepted local stores and deletions, then closes the
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
- **Typed write errors.** Native wraps storage rejections in opaque errors, so
  they surface as `io`.
- **Ingress tree check.** Native does not check that a peer's signed record
  names the tree it is delivered for; the bridge stores it as sent.
- **Same-key conflicts.** Nothing detects a different record arriving under an
  existing commit ID or fragment head; the later one overwrites.
- **Stream recovery.** A local storage error during a native peer round can end
  a session's stored-data stream; the session then fails rather than resuming.
- **Round failures.** A peer whose sync round hits a local storage error is
  left out of native's results, so the round can report `no-peers` with that
  peer still connected.
- **Absent documents.** Native's stored stream reports neither failed peer
  rounds nor an empty settled load. When a session's local load is empty and
  peers are connected, the backend runs one explicit round to decide whether
  any of them has the document.

## Limits

`syncTimeoutMilliseconds` sets Subduction's default request deadline, used by
explicit and store-triggered sync rounds. Unset, Subduction's own default
applies (currently 30 s); Subduction validates the value (a u32 of
milliseconds) and the constructor throws its `TypeError` otherwise.

A write reads nothing; it does not rescan the tree. A
`store()`/`create()` submission of any size is accepted and written in one
native call. Native validates it before signing or writing anything; records
over the wire count limits (255 unique commit parents or fragment boundary IDs,
65,535 checkpoints) are rejected as `invalid-record`. It is not split: a document must already fit
in Automerge's WASM memory, which is exhausted long before a submission would
strain Subduction's. Neither a single record nor a tree's total history is
capped: whatever was accepted can always be reopened, enumerated, synced and
deleted. Each open session consumes one native stored-data stream: its initial scan is
delivered as a single blob event, so very large trees cost time and heap
proportional to their size rather than being refused. This does not supply a
source-head marker: Repo accepts nonempty document heads after the entire blob
batch has been applied. Later stored items, local or from peers, follow as live
records; recovery scans arrive as further blob events. Live delivery, initial
blob size, total heap use, session count and queued operations are not bounded.
This is not a streaming or production large-history write path.

## Dependency and tests

From the workspace root:

```sh
pnpm --filter @automerge/automerge-repo build
pnpm --filter @automerge/automerge-repo-subduction build
pnpm exec vitest run --project repo-subduction
pnpm exec tsc -p packages/automerge-repo-subduction/test/tsconfig.json
```
