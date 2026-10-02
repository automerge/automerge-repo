# Sedimentree backend scaffold

Experimental backend contract provided by `@automerge/automerge-repo/sedimentree`.
See [`SUBDUCTION_INTEGRATION.md`](../../../../SUBDUCTION_INTEGRATION.md).
This entrypoint has **no external runtime imports**: no document handles,
Automerge, Subduction, transports, or WASM. Importing that subpath does not
load document orchestration.
Names, event schemas and conflict handling remain provisional.

The pure Automerge translation is available separately through
`@automerge/automerge-repo/sedimentree/automerge`; see its [README](./automerge/README.md).
The testing-only backend is exported through `/sedimentree/testing`, not the
contract entrypoint.

Import its types and helpers directly from
`@automerge/automerge-repo/sedimentree`; translation and test utilities use
separate subpaths.

## Plain values and ownership

IDs are branded **lowercase hex strings**, constructed by `sedimentreeId`,
`commitId`, and `checkpointId`. Logical tree IDs retain their 16/32-byte distinction.
All 16- and 32-byte logical IDs are accepted, including zero-padded IDs.
Commit IDs are 32 bytes. Fragment checkpoint prefixes are 12 bytes, matching the
sedimentree wire model; `checkpointForCommit` explicitly truncates a full commit
ID. A stream's `HistoryCheckpoint` instead contains full commit heads.

A record's logical key is its kind plus commit ID/fragment head, scoped to its
tree. `copyRecord` canonicalizes metadata sets and copies bytes, including Buffer
inputs. `equalRecords` compares **canonical exact representations**, not history
equivalence. It does not prove fragment coverage. Backends snapshot mutable
inputs before returning control, so callers may immediately reuse their arrays
and buffers without awaiting the store promise. Returned metadata is readonly
and may be frozen/shared; delivered writable byte buffers belong to each observer
and must not alias storage or another observer's buffers.

## Observation

`open` establishes a finite initial cut **before the first pull**, followed by
live updates. Initial records precede `local-load-complete`. Checkpoint delivery
is not acknowledgment that the consumer has applied its records; the translator
must check history inclusion. An empty load is not a readiness proof.

Streams have one consumer and allow only one outstanding `next()`. Closing a
session, ending iteration, or closing the backend wakes a pending pull. Multiple
sessions have independent lifetimes. A stream that exceeds the bounded replay
window emits `rescan-required`, ends, and releases interest. Reopen for a fresh
cut, merging history without clearing the application's state or pending edits.
Collection observation follows the same pattern, without materializing documents.

Deletion invalidates existing sessions and supersedes queued old-generation
records with a final `deleted` event. A later explicit open/store can reacquire
the ID. Deletion is not a replicated tombstone. A closed backend rejects new work.

## Deterministic memory test double

```ts
import { MemoryBackend } from "@automerge/automerge-repo/sedimentree/testing"
```

This is **not a production default**. It retains exact records, creates no network
connections, and performs no compaction or reclamation. Same logical key with
conflicting metadata/blob bytes rejects explicitly. This is deliberately stricter
than Subduction's variant resolution and cannot validate cross-backend coverage.
Empty/duplicate stores are no-ops. Neither exact conflict rejection nor batch
atomicity is a requirement on other backends. The double currently stages its
batch before writing as an implementation convenience, not a contract guarantee.
A rejected store may have partially persisted; callers must be able to retry valid
records without duplicate effects, rather than relying on rollback.

Initial snapshots retain private references to immutable records and copy blob
bytes on pull. Live replay is bounded by event count and encoded payload/metadata
bytes; batching is bounded by record count and target bytes. A single record may
exceed the batch target but never the configured hard record-size limit. These
are transport-buffer budgets, not a bound on the entire JS heap. The authoritative
in-memory store retains history; overflow only drops replay, not stored records.
Snapshot metadata is proportional to stored records, and checkpoint computation
is a simple metadata scan. This is a test double, not a production large-store
implementation.

Stores finish synchronously in memory, so `flush` has an immediate barrier.
`synchronize` reports `no-peers` with an ordered stream checkpoint. An already
aborted signal rejects that caller only. Ephemeral publication has no recipients
and is a best-effort no-op, not simulated transport delivery. Backend close
releases watches and memory; its process-local state cannot be reopened afterward.

## Scope and validation

The initial shared observation/lifecycle suite is in
`packages/automerge-repo/test/sedimentree/backend.contract.ts`.
Its opaque fixtures and deterministic scheduler should be parameterized when real
backends are added. Memory-specific tests separately cover exact conflicts and
replay limits. The public contract does **not yet freeze** inbound-demand
resolution, generic coverage operations, composite child observations, or remote
transport behavior; those require phase 1b with real backends.

From the workspace root:

```sh
pnpm --filter @automerge/automerge-repo build
pnpm exec vitest run packages/automerge-repo/test/sedimentree/
pnpm exec tsc -p packages/automerge-repo/test/sedimentree/tsconfig.json
```
