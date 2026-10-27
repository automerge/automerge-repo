# Sedimentree backend scaffold

Experimental backend contract provided by `@automerge/automerge-repo/sedimentree`.
This entrypoint has **no external runtime imports**: no document handles,
Automerge, Subduction, transports, or WASM. Importing that subpath does not
load document orchestration.
Names, event schemas and conflict handling remain provisional.

The pure Automerge translation is available separately through
`@automerge/automerge-repo/sedimentree/automerge`; see its [README](./automerge/README.md).
Import its types and helpers directly from
`@automerge/automerge-repo/sedimentree`; translation uses a separate subpath.

## Plain values and ownership

IDs are branded **lowercase hex strings**, constructed by `sedimentreeId`,
`commitId`, and `checkpointId`. Tree IDs are 32 bytes; other lengths reject
with an `invalid-id` backend error. `mintDocumentId` is the default minter for
new trees; backends and Repo accept a `mintDocumentId` option to replace it.
Commit IDs are 32 bytes. Fragment checkpoint prefixes are 12 bytes, matching the
sedimentree wire model; `checkpointForCommit` explicitly truncates a full commit
ID. A stream's `HistoryMarker` instead contains full commit heads.

A record's logical key is its kind plus commit ID/fragment head, scoped to its
tree. `copyRecord` canonicalizes metadata sets and copies bytes, including Buffer
inputs. Backends snapshot mutable
inputs before returning control, so callers may immediately reuse their arrays
and buffers without awaiting the store promise. Returned metadata is readonly
and may be frozen/shared; delivered writable byte buffers belong to each observer
and must not alias storage or another observer's buffers.

## Observation

`open` establishes initial loading **before the first pull**, followed by live
updates. Initial records (or a single unlabelled blob batch) precede
`local-load-complete`. Record markers require history-inclusion checks; blob
delivery has no independent marker and currently treats successful application
with nonempty document heads as ready. An empty load is not a readiness proof.

Streams have one consumer and allow only one outstanding `next()`. Closing a
session, ending iteration, or closing the backend wakes a pending pull. Multiple
sessions have independent lifetimes. Live events queue per session until
pulled.

The backend decides which boundary commits need a fragment and sends
`fragments-requested` after the delivery that revealed them; the consumer
builds and stores those fragments. `fragmentRequests` derives requests
statelessly from one delivery's metadata, for backends that have no native
signal.

Deletion invalidates existing sessions and supersedes queued old-generation
records with a final `deleted` event. A later explicit open/store can reacquire
the ID. Deletion is not a replicated tombstone. A closed backend rejects new work.

Ephemeral envelopes carry untrusted claimed `origin` for loop suppression.
The event's `sender` identifies the authenticated signed originator, not the
immediate relay/transport peer. Application sender identity comes from `sender`,
never from the envelope's claimed origin. Ephemeral data is not persisted.

## Deterministic memory test double

`MemoryBackend` lives in `packages/automerge-repo/test/helpers/` and is not
exported. It is **not a production default**. It retains exact records, creates no network
connections, and performs no compaction or reclamation. Same logical key with
conflicting metadata/blob bytes rejects explicitly. This is deliberately stricter
than Subduction's variant resolution and cannot validate cross-backend coverage.
Empty/duplicate stores are no-ops. Neither exact conflict rejection nor batch
atomicity is a requirement on other backends. The double currently stages its
batch before writing as an implementation convenience, not a contract guarantee.
A rejected store may have partially persisted; callers must be able to retry valid
records without duplicate effects, rather than relying on rollback.

Initial snapshots retain private references to immutable records and copy blob
bytes on pull. Live events queue per session until pulled. Batching is bounded
by record count and target bytes. A single record may exceed the batch target but
never the configured hard record-size limit. These are transport-buffer budgets,
not a bound on the entire JS heap.
Snapshot metadata is proportional to stored records, and marker computation
is a simple metadata scan. This is a test double, not a production large-store
implementation.

Stores finish synchronously in memory, so `flush` has an immediate barrier.
`synchronize` reports `no-peers` with an ordered history marker. An already
aborted signal rejects that caller only. Ephemeral publication has no recipients
and is a best-effort no-op, not simulated transport delivery. Backend close
releases watches and memory; its process-local state cannot be reopened afterward.

## Scope and validation

The initial shared observation/lifecycle suite is in
`packages/automerge-repo/test/sedimentree/backend.contract.ts`.
Its opaque fixtures and deterministic scheduler should be parameterized when real
backends are added. Memory-specific tests separately cover exact conflicts and
batch limits. The public contract does **not yet freeze** inbound-demand
resolution, generic coverage operations, composite child observations, or remote
transport behavior; those require phase 1b with real backends.

From the workspace root:

```sh
pnpm --filter @automerge/automerge-repo build
pnpm exec vitest run packages/automerge-repo/test/sedimentree/
pnpm exec tsc -p packages/automerge-repo/test/sedimentree/tsconfig.json
```
