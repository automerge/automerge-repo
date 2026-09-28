# Automerge Repo Subduction backend (experimental)

**Private experiment, not production-ready. Local-only, exclusive owner.
Supports loose commits and fragments; no transports, peers, compaction, or CRDT dependencies.** This is a
real `@automerge/subduction` engine and storage bridge, not a MemoryBackend
facade. For local development the dependency is currently linked to
`../../../subduction/subduction_wasm` (relative to this package), whose package
version is still **0.21.2** but includes unreleased fragment metadata APIs.

Fragment extraction, encoding and application belong to Repo's lightweight
`@automerge/automerge-repo/sedimentree/automerge` subpath, which uses the fragment
APIs in raw `@automerge/automerge` **3.5.0**. This backend depends on Repo but imports
only `@automerge/automerge-repo/sedimentree` at runtime, never its constructor,
document orchestration, or Automerge translation. This backend uses
`@automerge/subduction` only for the Subduction runtime, signing and storage;
Automerge remains a test-only dependency here.

## Fragment support and required native API

The linked local build supplies `Checkpoint`, `Fragment.fromCheckpointPrefixes`,
and checkpoint/tree-ID getters that published `@automerge/subduction` 0.21.2
lacks. They are required for this adapter's fragment support.

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
mean recoverable under the declared `persistence`; `persistent` need not mean
fsync. Missing values are `undefined`, not empty buffers; `remove` is idempotent.
Do not mutate supplied bytes. The namespace `subduction-v1/` must be exclusively
owned by this backend: no other engine, tab, process, or caller may mutate it
while the backend is alive. Storage is borrowed and is not closed or erased by
backend close. Concurrent multi-owner access and hostile storage are unsupported.

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

Readiness checkpoints are conservative, not necessarily minimal frontiers. Only
loose-commit dependencies prune delivered heads. Fragment boundary/checkpoint
claims cannot prove history inclusion in a standalone opaque blob, so they do not
suppress another record's target. The translator must check history inclusion.

Live replay is bounded per watch; overflow replaces pending delivery with a
terminal `rescan-required`. Iterator return/session close/backend close wake
pending pulls immediately. Initial asynchronous failures emit `failure` and end.
Deletion synchronously fences the old generation, rejects stores during its
barrier, drains prior queued work, calls native `removeSedimentree`, and cleans
up compound storage. A failed/ambiguous deletion forces active collection
observers to rescan rather than retaining an incorrect inventory. Later explicit
acquisition is permitted. Close rejects new
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

The sibling `subduction` checkout must have a built `subduction_wasm/dist`.
From this workspace root, run `pnpm install` to install dependencies and link that
package. Imports of both `@automerge/subduction` and `@automerge/subduction/slim`
resolve to the local build. Rebuilding it updates the linked runtime directly;
no registry publication is needed. This is a local-development dependency, not a
portable release pin; replace the link with a published version before sharing
an installation that does not include the sibling checkout.

After the main workspace dependency installation:

```sh
pnpm --filter @automerge/automerge-repo build
pnpm --filter @automerge/automerge-repo-subduction build
pnpm exec vitest run --project repo-subduction
pnpm exec tsc -p packages/automerge-repo-subduction/test/tsconfig.json
```

Tests initialize actual Node fullfat WASM and use a test-only temp filesystem
store with atomic rename (no fsync), failures and delayed saves. `controller.test.ts`
connects Repo's private `SedimentreeDocumentController` to this backend: initial
creation, handle edits, flush/reload without write-back, delayed/ambiguous failure
recovery, and deletion. A deterministic 2,000-change fixture exercises real
Automerge bundles alongside loose commits. Opaque fragment tests separately cover
nonempty checkpoints, same-head records of different kinds, corruption, limits,
partial writes, and lifecycle barriers. These tests use real `Document`/`DocHandle`/`DocumentQuery`
but **not Repo's public constructor**, which is still unchanged. Fresh-process
package import tests check that the contract/testing/translation subpaths and this
backend do not load Repo orchestration or initialize WASM implicitly.

The suite also runs the controller's creation/recovery path in two separate Node
processes for both commit-only and fragmented histories. To reproduce the fragment
case manually, use the same initially empty directory for both commands (run from
this package; omit `fragments` for the small commit-only fixture):

```sh
pnpm exec tsx test/fresh-process.ts write /path/to/test-directory fragments
pnpm exec tsx test/fresh-process.ts read /path/to/test-directory fragments
```

No test-only memory backend, Repo storage adapter, private contract runtime,
CRDT parser, or network behavior is used by the backend implementation. Only its
integration tests depend on Automerge and Repo's private controller.

The controller's focused test typecheck is available separately from the existing
legacy test configuration:

```sh
pnpm exec tsc -p packages/automerge-repo/test/tsconfig.sedimentree.json
```
