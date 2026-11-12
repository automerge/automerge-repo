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
new trees; backends accept a `mintDocumentId` option to replace it.
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
updates. Initial records precede `local-load-complete`, whose marker holds the
heads of the initial cut; Repo applies the cut in one load and checks history
inclusion against it. An empty load is not a readiness proof. After an empty
cut the backend asks connected peers itself and delivers a `synchronized`
result; Repo never starts a round. A `synchronized` marker is a target,
not a receipt: the records it names may arrive on the stream after it.

Streams have one consumer and allow only one outstanding `next()`. Closing a
session, ending iteration, or closing the backend wakes a pending pull. Multiple
sessions have independent lifetimes. Live events queue per session until
pulled.

A consumer compacts the boundary commits it stores. It also compacts those its
initial cut holds without a covering fragment, which `fragmentRequests`
derives from the cut's metadata.

A nonretryable `failure` is the final event of its session, superseding queued
events; retryable ones leave it open.

Deletion invalidates existing sessions and supersedes queued old-generation
records with a final `deleted` event. A later explicit open/store can reacquire
the ID. Deletion is not a replicated tombstone. A closed backend rejects new work.

## Handle extensions

A backend may add features to every handle of its Repo by listing
`handleExtensions`; a backend that lists none gives plain handles. Ephemeral
messaging is such an extension, provided by the Subduction backend.

- An extension subclasses the handle and may only add methods and getters,
  keeping any state of its own in private (`#`) fields. Repo throws at
  construction if two extensions share a `kind` or an extension redefines a
  member. It cannot see a property an extension sets on the handle itself
  (a class field, say), which could silently replace another's. A package
  that provides extensions should therefore run
  `await checkHandleExtensions(extensions)` in its tests: it makes Repo's
  checks and rejects those properties too.
- An extension reaches its backend through the document's session
  (`context.session`), using whatever methods that backend's sessions have.
  It names the session type it needs, `HandleExtension<Kind, Session>`.
  Nothing is added to the backend or session interfaces.
- It is the backend's job to make its sessions implement what its extensions
  need. Typing the extension against the backend's own session type, and
  declaring `open()` to return that type, makes the compiler check it. Core
  does not: a session lacking a method fails when the extension calls it.
- The backend reaches the extension with session events
  `{ type: "extension", kind, payload }`, which Repo hands to the extension's
  `receive`. The payload is typed by `kind`, from the extension's `inbound`
  declaration, so only declared kinds can be sent.
- Nothing here supports a backend that wraps or combines others. One built
  later would list the inner extensions it exposes, have its own sessions
  forward the methods they need, and pass the inner `extension` events on.
- Types: an extension declares what it adds under its kind in
  `HandleExtensionTypes` (`members`, `events` and `inbound`). A Repo built on a backend whose type names its
  extensions (`ExtendedBackend<K>`) returns `ExtendedHandle<T, K>`; a backend
  typed as plain `SedimentreeBackend` gives plain `DocHandle<T>`.
- Kinds and member names are global to a program. Two packages declaring the
  same kind with different types do not compile together, and two extensions
  cannot add the same member, so choose names unlikely to collide.

## In-memory backend

`MemoryBackend` is exported from this entrypoint and is Repo's default backend
when none is given; tests use it as the deterministic backend. It is process-local
and non-durable: nothing survives the process. It retains exact records, creates no network
connections, and performs no compaction or reclamation. Same logical key with
conflicting metadata/blob bytes rejects explicitly; with Automerge input this
does not arise, since a commit ID is the hash of its bytes and same-head
fragment variants are kept side by side. This is deliberately stricter
than Subduction's variant resolution and cannot validate cross-backend coverage.
Empty/duplicate stores are no-ops. Neither exact conflict rejection nor batch
atomicity is a requirement on other backends. The backend currently stages its
batch before writing as an implementation convenience, not a contract guarantee.
A rejected store may have partially persisted; callers must be able to retry valid
records without duplicate effects, rather than relying on rollback.

Initial snapshots retain private references to immutable records and copy blob
bytes on pull. Live events queue per session until pulled. Batching is bounded
by record count and target bytes. A single record may exceed the batch target but
never the configured hard record-size limit. These are transport-buffer budgets,
not a bound on the entire JS heap.
Snapshot metadata is proportional to stored records, and marker computation
is a simple metadata scan. It is not designed for large stores.

Stores finish synchronously in memory unless the `beforeStore` hook holds one
open, so `flush` normally has an immediate barrier.
An empty initial cut is followed by a `no-peers` `synchronized` result with an
ordered history marker. It provides no handle extensions. Backend close
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
