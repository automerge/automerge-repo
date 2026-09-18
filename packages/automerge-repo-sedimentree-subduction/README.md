# Experimental local Subduction backend

**Private experiment, not production-ready. Local-only, exclusive owner,
COMMIT-ONLY. No transports, peers, compaction, or CRDT dependencies.** This is a
real `@automerge/subduction` **0.21.2** engine and storage bridge, not a
MemoryBackend facade.

Fragment extraction, encoding and application belong to the separate
`automerge-repo-sedimentree-automerge` translation package, which uses the fragment
APIs in raw `@automerge/automerge` **3.5.0**. This backend uses
`@automerge/subduction` only for the Subduction runtime, signing and storage;
Automerge remains a test-only dependency here.

## Blocking restriction: fragments are unsupported by this adapter

Automerge's fragment APIs are supported by the translator. The remaining adapter
restriction is reading native metadata back: `@automerge/subduction` 0.21.2's
public `Fragment` has no checkpoints getter, and its constructor accepts full
32-byte commit IDs rather than the contract's 12-byte checkpoint prefixes.
This adapter therefore rejects **every submitted fragment** with
`BackendError(code: "unsupported")`, including fragments with empty checkpoints.
Persisted fragment keys also fail observation/store/deletion rather than being
ignored, stripped of checkpoints, or interpreted with an invented wire parser.
There is no durable metadata sidecar or fake fragment support. Do not use this
adapter for an Automerge history requiring bundled fragments.

## Construction and ownership

```ts
// Node: initialize fullfat BEFORE constructing the slim-backed implementation.
import { MemorySigner } from "@automerge/subduction"
import { SubductionBackend } from "@automerge/automerge-repo-sedimentree-subduction"

const signer = MemorySigner.generate()
const backend = new SubductionBackend({
  signer,
  storage: byteStore,
  persistence: "persistent", // explicit claim about your injected store
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
`CommitInput` consumes `LooseCommit`, `storeBuiltBatch` consumes `CommitInput`,
and `CommitWithBlob` consumes `SignedLooseCommit`.

The injected `LocalByteStore` has exactly:

```ts
load(key: string): Promise<Uint8Array | undefined>
save(key: string, data: Uint8Array): Promise<void>
remove(key: string): Promise<void>
list(prefix: string): Promise<string[]> // full keys with this prefix
```

`save` **must atomically replace one entire value**. Successful resolution must
mean recoverable under the declared `persistence`; `persistent` need not mean
fsync. Missing values are `undefined`, not empty buffers; `remove` is idempotent.
Do not mutate supplied bytes. The namespace `subduction-v1/` must be exclusively
owned by this backend: no other engine, tab, process, or caller may mutate it
while the backend is alive. Storage is borrowed and is not closed or erased by
backend close. Concurrent multi-owner access and hostile storage are unsupported.

## Persistence and integrity

Stores call real `Subduction.storeBuiltBatch`, **not** network-awaiting `addBatch`.
Each commit is one versioned JSON compound value containing native
`signed.encode()` bytes, blob bytes, native tree/key identity, and a checksum of
the signed envelope. Bytes are hex encoded (experimental overhead). There is
**no batch transaction**: despite native's `saveBatchAll` interface name, this
bridge saves compound records sequentially and atomically _per record_.

Reads decode with `SignedLooseCommit.tryDecode`; native hydration receives
`new CommitWithBlob(signed, blob)`. Fresh backend open exercises real native
`getCommits` hydration. Enumeration comes from authoritative compound storage,
never from pairing minimized native metadata with `getBlobs`. Reconstructing a
native loose commit and comparing its digest validates the signed tree identity,
logical commit key, parents and blob digest/size without parsing native wire
bytes. Commit IDs remain independent of blob digests. Native hydration trusts
stored signatures; the additional envelope checksum detects damaged signature
bytes but is **not cryptographic signature authentication against hostile
storage**. Signatures originate in the actual native store path.

Malformed records fail rather than look absent. ID markers may precede a failed
first save; collection enumeration filters those empty/phantom IDs, discovers
records even without a marker, and rejects unsupported fragment records.
Logical 16-byte IDs append 16 zero bytes at the native boundary. Native 32-byte
IDs are preserved; reversing the reserved zero-suffix range yields a logical
16-byte ID. Nothing is truncated.

Different representations for the same tree/commit key are conservatively
rejected; exact retries are safe. This is **not actual Subduction variant-
equivalence conformance**. The adapter never acknowledges a silently discarded
variant, never removes covered records, and performs no wrapper compaction.
After a failed native store, a fresh engine avoids stale in-memory state on retry.
Successful stores verify that every submitted representation is recoverable.

## Ordering, observations, limits

A single serialized owner queue reserves order synchronously at `open`, `store`,
`observeCollection`, and synchronization calls. An initial cut is finite and
reserved before later writes, even before the first iterator pull. Snapshot
acquisition uses this queue; consumption does not hold it. Each observer owns
its delivered bytes. Only successful compound saves produce live notifications;
a partially failed batch can already be observed and recovered. A failed native
store forces active document/collection watches to rescan: a byte-store save may
have committed data before rejecting, so retry deduplication alone cannot repair
missed notifications. Retry does not require rollback. Successful stores publish
a live checkpoint after their data. Local synchronization emits an ordered `no-peers` result;
aborting cancels only the caller's wait. Ephemeral publication has no recipients.

Live replay is bounded per watch; overflow replaces pending delivery with a
terminal `rescan-required`. Iterator return/session close/backend close wake
pending pulls immediately. Initial asynchronous failures emit `failure` and end.
Deletion synchronously fences the old generation, rejects stores during its
barrier, drains prior queued work, calls native `removeSedimentree`, and cleans
up compound storage. Later explicit acquisition is permitted. Close rejects new
work, fences notifications, drains accepted operations, disconnects/frees native
resources, and does not use a forced timeout.

Flush captures only already accepted targeted stores, drains **all** of them,
and aggregates failures. Failed attempts remain in a process-local ledger
until a captured flush (or close) reports them; a successful retry does not erase
an unreported failure. Concurrent barriers may both report the same failure.
Completed successful attempts are not retained. Close reports unflushed failures
after attempting cleanup.

Default limits:

| Option             |                                                                 Default |
| ------------------ | ----------------------------------------------------------------------: |
| `maxRecordBytes`   |                               16 MiB (native signed metadata plus blob) |
| `maxSnapshotBytes` |          64 MiB (plain encoded history budget per tree and input batch) |
| `maxRecords`       | 10,000 per tree; namespace enumeration also capped at 3× this many keys |
| `batchRecords`     |                        128 (input maximum and initial delivery maximum) |
| `batchBytes`       |                1 MiB initial delivery target; one larger record allowed |
| `replayEvents`     |                                                           128 per watch |
| `replayBytes`      |                                                         4 MiB per watch |

This intentionally simple experiment scans history to validate/store/checkpoint.
Snapshots pin complete records including blobs, not just cursor metadata. Native
hydration may read them again. Each open can retain a separate bounded snapshot;
number of sessions and queued caller operations are not bounded. Storage `list`
and `load` allocate their whole result before limits can be checked. These are
encoded budgets, **not total heap bounds**, and this is not a large-store/streaming
implementation. Submission backpressure/coalescing must precede production use.

## Tests

After the main workspace dependency installation:

```sh
pnpm --filter @automerge/automerge-repo-sedimentree build
pnpm --filter @automerge/automerge-repo-sedimentree-subduction build
pnpm exec vitest run --project sedimentree-subduction
pnpm exec tsc -p packages/automerge-repo-sedimentree-subduction/test/tsconfig.json
```

Tests initialize actual Node fullfat WASM and use a test-only temp filesystem
store with atomic rename (no fsync), failures and delayed saves. `controller.test.ts`
connects Repo's private `SedimentreeDocumentController` to this backend: initial
creation, handle edits, flush/reload without write-back, delayed/ambiguous failure
recovery, and deletion. These tests use real `Document`/`DocHandle`/`DocumentQuery`
but **not Repo's public constructor**, which is still unchanged.

The suite also runs the controller's creation/recovery path in two separate Node
processes. To reproduce it manually, use the same initially empty directory for
both commands (run from this package):

```sh
pnpm exec tsx test/fresh-process.ts write /path/to/test-directory
pnpm exec tsx test/fresh-process.ts read /path/to/test-directory
```

No test-only memory backend, Repo storage adapter, private contract runtime,
CRDT parser, or network behavior is used by the backend implementation. Only its
integration tests depend on Automerge and Repo's private controller.

The controller's focused test typecheck is available separately from the existing
legacy test configuration:

```sh
pnpm exec tsc -p packages/automerge-repo/test/tsconfig.sedimentree.json
```
