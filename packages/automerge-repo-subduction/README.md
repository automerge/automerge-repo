# Automerge Repo Subduction backend (experimental)

**Private experiment, not production-ready. Exclusively owned storage, with
explicit authenticated peer connections. Supports loose commits and fragments;
no compaction or CRDT dependencies.** This is a real `@automerge/subduction`
engine and storage bridge, not a MemoryBackend facade or a simulated protocol.
The adapter targets `@automerge/subduction` **0.23.0**, including its native
fragment metadata APIs.

Fragment extraction, encoding and application belong to Repo's lightweight
`@automerge/automerge-repo/sedimentree/automerge` subpath, which uses the fragment
APIs in raw `@automerge/automerge` **3.5.0**. This backend imports
`@automerge/automerge-repo/sedimentree` at runtime, never Repo's constructor,
document orchestration, or Automerge translation. This backend uses
`@automerge/subduction` only for the Subduction runtime, signing and storage;
Automerge remains a test-only dependency here.

## Fragment support and required native API

Native 0.23.0 supplies `Checkpoint`, `Fragment.fromCheckpointPrefixes`, and
checkpoint/tree-ID getters. They are required for this adapter's fragment support.

Fragments preserve full head/boundary IDs and the native 12-byte checkpoint
prefixes, including empty checkpoint sets. Native signed payloads are the source
of metadata on reload; there is no metadata sidecar, CRDT decoding, or handwritten
native wire parser. The adapter checks native count limits before submission:
255 unique boundary IDs and 65,535 unique checkpoints per fragment.

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

Browser/bundler applications must initialize the native WASM runtime themselves.
Implementation imports use `/slim`; construction is synchronous. The signer is
**borrowed**: keep it alive until close completes, then release it yourself.
The runtime's options retain a JS `Signer` interface, not a consumed signer
pointer; the real-WASM test verifies signing still works after backend close. In contrast,
`CommitInput`/`FragmentInput` consume their unsigned payloads, `storeBuiltBatch`
consumes both input wrapper arrays, and `CommitWithBlob`/`FragmentWithBlob` consume
their signed payloads. Metadata getters return independently owned native values;
the adapter copies their plain bytes and frees those wrappers.

The injected `LocalByteStore` has exactly:

```ts
load(key: string): Promise<Uint8Array | undefined>
save(key: string, data: Uint8Array): Promise<void>
remove(key: string): Promise<void>
list(prefix: string): Promise<string[]> // full keys with this prefix
```

`save` **must atomically replace one entire value**. Successful resolution must
mean recoverable under the store's documented guarantees (not necessarily fsync).
Missing values are `undefined`, not empty buffers; `remove` is idempotent.
Do not mutate supplied bytes. The namespace `subduction-v1/` must be exclusively
owned by this backend: no other engine, tab, process, or caller may mutate it
while the backend is alive. Storage is borrowed and is not closed or erased by
backend close. Concurrent multi-owner access and hostile storage are unsupported.

## Authenticated peer connections

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
native clones the connection. Keep the underlying JS transport alive until the
backend disconnects it. The returned boolean identifies a newly installed
connection, not necessarily a previously unknown peer. Callers own dialing,
handshake failure cleanup/deadlines, and reconnection; a Promise race alone does
not cancel a native handshake. Native WebSocket/long-poll authenticated wrappers
can also supply `toTransport()`; those conversions consume their wrappers.

Opening a session automatically schedules a document sync. Successful local
stores schedule propagation even without a session. Adding a connection replays
open interests and the local stored-ID inventory, so reconnecting with fresh
transports retrieves missed edits. There is no remote inventory discovery,
automatic dialer, timer-based retry, or production connection manager here.
This experiment uses native's default **allow-all authorization**; authenticated
identity is not an application sharing policy. Use only explicitly trusted peers.

Synchronization uses a separate queue from local persistence, with one running
round globally and coalesced automatic follow-up work per document. Each round snapshots connected
peers and returns their authenticated identities and individual outcomes.
`complete` describes native round success, **not remote durability, CRDT
readiness, exact representation equality, or global convergence**. Native wire
diffs use minimized, head-based metadata: differing same-kind/head variants may
never be transmitted even though the bridge rejects them if actually received.
A sender's final requested-data sends are not remote ingestion acknowledgments.

`syncTimeoutMilliseconds` defaults to 5,000 ms per native peer request. It covers
request send/response waiting, not arbitrary local storage or handshake work.
Aborting `session.synchronize()` cancels that caller's wait only. Remote-heads
events are advertisements and can precede ingestion; readiness checkpoints come
from serialized persisted-record cuts, never directly from that callback.

### Empty connected lookups

Native 0.23.0 cannot prove remote absence. Unknown IDs receive a successful
empty `SyncResult::Ok`, not `NotFound`. `syncWithPeer().success` only describes
the exchange; false without transport errors conflates unauthorized responses
and missing connections. `stats.remoteHeads` is response metadata, not an
authoritative inventory: the responder cache can lag already-persisted writes.
Neither empty remote heads nor an empty local checkpoint proves absence.

After a successful connected round, an empty local cut with no advertised remote
heads emits a non-retryable `BackendError("open", "unsupported", ...)` to the
session. Public `repo.find()` therefore rejects with `unsupported`, not
`unavailable`, rather than hanging. The native exchange still reports `complete`;
that does not imply that initial document acquisition is supported. If the peer
advertises nonempty heads, delayed ingestion remains pending and is not failed
by this empty-lookup check. No native response is mapped to peer `unavailable`.
An unsuccessful response with no transport errors is similarly unsupported,
not proof of absence; an empty acquisition ends with the same `open` error.

This conservative limit can reject a real document during a remote cache-lag
window. The failed observation ends, but later native writes may still persist;
explicitly evict/reacquire after data arrives. A failed Repo query is terminal.
Do not broaden Repo's unavailable condition to include successful empty local
checkpoints. A reliable missing-document result needs a native existence/absence
response with defined consistency semantics; neither a timeout nor a second
empty sync round supplies that guarantee.

Read-only Rust evidence: `subduction_core/src/handler/sync.rs`,
`recv_batch_sync_request` (cache-coherence note, ephemeral empty tree, unconditional
`SyncResult::Ok`); `subduction_core/src/subduction.rs`, `sync_with_peer`
(`NotFound`/`Unauthorized` collapsed into unsuccessful, ingestion before return);
`subduction_wasm/src/subduction.rs`, `PeerBatchSyncResult`; and
`subduction_wasm/src/sync_stats.rs`, `remote_heads` (heads-only metadata getter).

Native has no document-unsubscribe API: closing a session releases that observer,
not the connection's protocol subscriptions. Other sessions continue normally.
**Deletion and storage-error recovery conservatively disconnect all peers**,
including those used by unrelated documents; reconnect explicitly afterward.
Network ephemerals are not implemented: publication with connected peers rejects
with `unsupported`, rather than silently pretending to send. With no peers it
remains a no-op. Composition, permissions, socket/browser integration tests, and
production subscription/resource management remain future work.

## Persistence and integrity

Stores call real `Subduction.storeBuiltBatch`, **not** network-awaiting `addBatch`.
Each commit or fragment is one versioned JSON compound value containing native
`signed.encode()` bytes, blob bytes, native tree/key identity, and a checksum of
the signed envelope. Bytes are hex encoded (experimental overhead). There is
**no batch transaction**: despite native's `saveBatchAll` interface name, this
bridge saves compound records sequentially and atomically _per record_.

Reads decode with `SignedLooseCommit.tryDecode` or `SignedFragment.tryDecode`;
native hydration receives the corresponding `CommitWithBlob`/`FragmentWithBlob`.
Fresh backend open exercises real native `getCommits`/`getFragments` hydration.
Enumeration comes from authoritative compound storage, never from pairing
minimized native metadata with `getBlobs`. Reconstructing a native loose commit
and comparing its digest validates its tree identity, key, parents and blob
metadata. For fragments, native payload getters expose the tree ID, head,
boundary, checkpoints and blob metadata; the adapter checks tree/key identity
and compares the signed blob size/digest with the actual bytes. Commit IDs remain
independent of blob digests. Native hydration trusts stored signatures; the
additional envelope checksum detects damaged signature bytes but is **not
cryptographic signature authentication against hostile storage**. Signatures
originate in the actual native store path.

Malformed records fail rather than look absent. ID markers may precede a failed
first save; collection enumeration filters those empty/phantom IDs, discovers
records of either kind even without a marker, and rejects corrupt records.
Logical 16-byte IDs append 16 zero bytes at the native boundary. Native 32-byte
IDs are preserved; reversing the reserved zero-suffix range yields a logical
16-byte ID. Nothing is truncated.

Different representations for the same tree/kind/head key are conservatively
rejected; exact retries are safe. A loose commit and a fragment sharing a head
remain distinct records, even when native in-memory minimization covers one.
Existing compound commit records retain their format; fragments occupy a separate
`fragments/` namespace with explicit `kind` and `head` fields. This is **not actual Subduction variant-
equivalence conformance**. The adapter never acknowledges a silently discarded
variant, never removes covered records, and performs no wrapper compaction.
After a failed native store, a fresh engine avoids stale in-memory state on retry.
Successful stores verify that every submitted representation is recoverable.

## Ordering, observations, limits

A serialized owner queue reserves local operations synchronously at `open`,
`store`, and `observeCollection`. A separate storage queue serializes whole
transactions, including native incoming writes and reads. Observations are
installed **inside** those read transactions, with no snapshot-to-watch gap.
A synchronization call captures earlier local work but performs network waiting
outside the owner queue. Initial cuts are finite and established before the
first iterator pull; consumption holds neither queue. Each observer owns
its delivered bytes. Only successful compound saves produce live notifications;
a partially failed batch can already be observed and recovered. Failed native
mutations force affected document/collection watches to rescan: a byte-store save
may have committed data before rejecting, so retry deduplication alone cannot
repair missed notifications. Retry does not require rollback. Successful incoming
and local saves publish coalesced live checkpoints after their data. Explicit and
automatic rounds emit ordered synchronization results; rounds started without
connections report `no-peers`, not global absence.

Readiness checkpoints are conservative, not necessarily minimal frontiers. Only
loose-commit dependencies prune delivered heads. Fragment boundary/checkpoint
claims cannot prove history inclusion in a standalone opaque blob, so they do not
suppress another record's target. The translator must check history inclusion.

Live replay is bounded per watch; overflow replaces pending delivery with a
terminal `rescan-required`. Iterator return/session close/backend close wake
pending pulls immediately. Initial asynchronous failures emit `failure` and end.
Deletion synchronously fences the old generation, rejects stores during its
barrier, disconnects peers, revokes the old engine's storage access, drains
accepted operations, calls native `removeSedimentree`, and cleans up compound
storage. A failed/ambiguous deletion forces active collection
observers to rescan rather than retaining an incorrect inventory. Later explicit
acquisition is permitted. Close rejects new
work and ends observations immediately, cancels peer waits, then drains accepted
local work. It revokes the engine's storage view before draining incoming writes
and freeing resources. Native `disconnectAll()` alone does **not** drain incoming
handlers; late calls from retired engines reject instead of resurrecting deleted
history. Close does not use a forced timeout.

Flush captures accepted targeted local stores and native storage mutations,
drains **all** captured work, and aggregates failures without waiting for peers.
It does not cover network messages that have not yet entered the storage bridge.
Failed attempts remain in process-local ledgers until flush/close reports them;
a successful retry does not erase an unreported failure. Local submissions and
native mutations are tracked independently, so the same underlying I/O error may
appear in both ledgers (and in overlapping barriers). A settled-failure sweep also
reports failures from captured local jobs that entered native storage after the
flush call, without waiting for later writes. Completed successful attempts are
not retained. Close reports unflushed failures after attempting cleanup.

Default limits:

| Option                    |                                                                 Default |
| ------------------------- | ----------------------------------------------------------------------: |
| `syncTimeoutMilliseconds` |                                        5,000 ms per native peer request |
| `maxRecordBytes`          |                               16 MiB (native signed metadata plus blob) |
| `maxSnapshotBytes`        |          64 MiB (plain encoded history budget per tree and input batch) |
| `maxRecords`              | 10,000 per tree; namespace enumeration also capped at 3× this many keys |
| `batchRecords`            |                        128 (input maximum and initial delivery maximum) |
| `batchBytes`              |                1 MiB initial delivery target; one larger record allowed |
| `replayEvents`            |                                                           128 per watch |
| `replayBytes`             |                                                         4 MiB per watch |

This intentionally simple experiment scans history to validate/store/checkpoint.
Record and snapshot budgets count both kinds together. Each saved record currently
revalidates the full stored history, so batch work can be quadratic; this is not a
production large-history write path.
Snapshots pin complete records including blobs, not just cursor metadata. Native
hydration may read them again. Each open can retain a separate bounded snapshot;
number of sessions and queued caller operations are not bounded. Storage `list`
and `load` allocate their whole result before limits can be checked. These are
encoded budgets, **not total heap bounds**, and this is not a large-store/streaming
implementation. Submission backpressure/coalescing must precede production use.

## Local dependency and tests

The local `subduction` checkout must have a built `subduction_wasm/dist`.
The workspace override links its absolute path so temporary worktrees resolve it.
From this workspace root, run `pnpm install` to install dependencies and link that
package. Imports of both `@automerge/subduction` and `@automerge/subduction/slim`
resolve to the local build. Rebuilding it updates the linked runtime directly;
no registry publication is needed. This is a local-development dependency, not a
portable release pin; replace the link with a published version before sharing
an installation that does not include the local checkout.

After the main workspace dependency installation:

```sh
pnpm --filter @automerge/automerge-repo build
pnpm --filter @automerge/automerge-repo-subduction build
pnpm exec vitest run --project repo-subduction
pnpm exec tsc -p packages/automerge-repo-subduction/test/tsconfig.json
```

Tests initialize actual Node fullfat WASM and use a test-only temp filesystem
store with atomic rename (no fsync), failures and delayed saves. Backend tests
cover creation (including supplied IDs), persistence, observation, and deletion.
Opaque fragment tests cover nonempty checkpoints, same-head records of different
kinds, corruption, limits, partial writes, and lifecycle barriers.

`network-lifecycle.test.ts` uses real authenticated Subduction wire traffic over a
copying, FIFO, paired byte transport. Authentication, reconciliation, ingestion,
and disk recovery are real native operations, not mocked. It covers request
timeouts, cancellation, failed onboarding, delayed and ambiguous incoming writes,
flush/close barriers, deletion fencing, and retry after reconnect.
`storage-bridge.test.ts` separately stresses serialized transaction races and
native input lifetimes. Fresh-process
package import tests check that the contract/testing/translation subpaths and this
backend do not load Repo orchestration or initialize WASM implicitly.

No test-only memory backend, Repo storage adapter, private contract runtime,
CRDT parser, or simulated network behavior is used by the backend implementation.
Only translation and integration tests depend on Automerge. Private-controller
tests and their fresh-process recovery fixture are intentionally not included;
public Repo integration is tested separately.
