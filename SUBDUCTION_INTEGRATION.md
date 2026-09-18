# Subduction integration

**Status:** Agreed direction and initial scope, ready for an executable scaffold.
API names and signatures remain provisional; the remaining implementation checks
are listed at the end.

## Summary

Replace Repo's built-in storage, network, and legacy synchronization machinery
with a **sedimentree backend**. Repo will exchange loose commits, fragments, and
opaque blobs with that backend rather than storage keys, network messages, or
Automerge sync states. `new Repo()` constructs a default Subduction backend;
`new Repo({ backend })` uses the supplied backend instead, without also starting
the default.

Provide two concrete implementations:

- A Subduction backend, wrapping Subduction behind a cleaner interface.
- A legacy backend, translating sedimentrees to and from Automerge documents and
  using the existing sync protocol and storage format internally.

Also support running both simultaneously through a **composite backend**,
implemented in a separate package against the same public contract. Repo still
receives one backend; it does not need to know whether that backend is composed.

Start from `main`. Extract its legacy implementation and selectively bring over
Subduction code and regression tests from `subductionjs`. Do not merge the branch
or adopt its current integration API wholesale.

The objective is not just interchangeable sync protocols. Sedimentrees should
become the common representation beneath Repo, allowing future document
implementations based on CRDTs other than Automerge. For expediency, Repo retains
its Automerge dependency and gains the default Subduction dependency in this
work. Splitting out a core independent of both is a later project.

## Goals and non-goals

### Goals

- Accept one injected sedimentree backend, with Subduction as the default.
- Make the contract composable: a separate package can combine legacy and
  Subduction backends, including cross-propagation, without Repo special cases or
  access to either backend's private implementation.
- Remove legacy storage/network adapters and sync protocol handling from core
  Repo, moving them into one legacy package.
- Keep the backend contract independent of Automerge, Repo handles, Subduction
  WASM classes, storage adapters, and transport implementations.
- Make initial loading, live updates, persistence, synchronization, and teardown
  explicit, with testable ordering and failure semantics.
- Preserve existing Automerge document behavior and legacy interoperability
  through the legacy implementation.
- Avoid forcing application documents to be materialized just to replicate or
  persist sedimentrees.

### Non-goals for this work

- Implementing another CRDT, generic public handles, a complete CRDT plugin
  registry, or a dependency-free core Repo package. The first Repo-to-sedimentree
  translation remains Automerge-specific.
- Implementing multiple protocol stacks or backend-combination logic inside
  core Repo. Simultaneous operation belongs in an injected composite backend,
  not in a special dual-protocol Repo mode.
- Making the legacy backend support arbitrary or encrypted CRDT payloads.
- Designing E2EE, authorization, or a new identity system. The boundary must not
  prevent these, but we should not transplant the branch's encryption machinery
  as part of the initial extraction.
- Migrating existing storage to Subduction's format. The legacy backend should
  initially read and write the existing format.
- Preserving every constructor option, hidden subsystem property, or adapter
  import path in core Repo. This is an API-breaking architectural change.

## Starting point

Relevant code on `main`, under `packages/automerge-repo/src/`:

| Code                                                 | Current responsibility                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Repo.ts`                                            | Constructs and wires storage, network, synchronizer, remote-head tracking, and document sources; owns queries and lifecycle operations. |
| `Document.ts`, `DocHandle.ts`                        | Own Automerge state, mutations, views, sub-handles, and document events.                                                                |
| `DocumentQuery.ts`                                   | Combines document state and source observations into public loading/availability state.                                                 |
| `DocumentSource.ts`                                  | Defines source attachment/detachment and availability priority.                                                                         |
| `StorageSource.ts`, `storage/`                       | Load and save Automerge snapshots/incrementals; persist sync state and storage identity.                                                |
| `synchronizer/`, `network/`                          | Run legacy sync, discover documents, evaluate sharing, and route messages.                                                              |
| `SyncStateTracker.ts`, `RemoteHeadsSubscriptions.ts` | Track remote heads, persist legacy sync state, and implement legacy gossip.                                                             |

`DocumentSource` is a useful existing integration point, but is **not** the new
backend contract: it exposes `DocumentQuery` and `DocHandle`, putting the boundary
above the CRDT representation. It may help stage the refactor internally, but
must not become the public extension point for sedimentree backends.

On `subductionjs`, `subduction/source.ts` combines CRDT translation, hydration,
connection management, retries, save scheduling, compaction, and blob
interception. It also listens to `SubductionStorageBridge` storage events to
learn about new data. `Repo.ts` still constructs both protocol stacks and routes
Subduction ephemeral messages through the legacy synchronizer.

These are useful implementation references, not the desired architecture. Main
also has fixes that must not be lost by replacing files with branch versions,
including bounded/draining flush behavior and ephemeral relay/deduplication
behavior.

## Architecture

```text
Application
    |
Repo / DocumentQuery / handles
    |
Automerge <-> sedimentree translation       Future CRDT translations
    |                                               |
    +-----------------------+-----------------------+
                            |
                 Sedimentree backend contract
                            |
             +--------------+----------------+
             |                               |
      Subduction backend                Legacy backend
             |                               |
         Subduction                sedimentree <-> Automerge.Doc
             |                               |
      storage/transports             legacy sync + storage
```

The implementations below the contract can be used individually or as children
of a composite backend. Composition happens entirely below the same contract;
children are not registered as additional Repo document sources.

### Core Repo

Repo continues to own document identity, queries, application handles, and their
lifecycle. Initially, document operations remain Automerge-specific. The default
constructor creates a Subduction backend, but document orchestration operates
through the same contract used by explicitly injected backends.

A small translation layer extracts sedimentree records from Automerge state and
applies incoming record blobs to that state. It must not contain transport,
storage-format, peer-policy, or reconnection logic.

### Backend

The backend owns persistence, replication, peer connections, protocol-specific
policy, and internal resource management. It reports sedimentree data and
backend facts; it does not decide whether an application document is usable.

Incoming replication must work without calling `Repo.find()` or creating public
handles. A legacy backend may need an internal Automerge document to serve a
peer; that is its implementation detail, not an application document in Repo.
Application-facing discovery reports IDs, not materialized handles. Applications
that want a handle explicitly call `find()`; merely discovering or replicating
a document does not populate Repo's handle cache.

### Packaging

Initial responsibilities, with final package names still to be chosen:

- **Contract package:** plain sedimentree data types, backend interfaces, and
  shared conformance-test support. No Repo, Automerge, or Subduction runtime
  dependency.
- **Automerge translation module/package:** small reusable conversion helpers,
  shared by core Repo and the legacy backend. Depends on Automerge and the
  contract, not Repo. Avoid duplicating fragment extraction logic.
- **Repo package:** public document API and translation orchestration. Depends
  on the contract, Automerge translation, and the Subduction backend for default
  construction. It does not depend on the legacy or composite implementation.
  A separately packaged core with no Automerge or Subduction dependency is
  deferred; the contract package is independent of both from the outset.
- **Legacy package:** legacy translation, synchronizers, storage subsystem,
  network subsystem, remote-head gossip, and existing adapter implementations.
- **Subduction package:** Subduction wrapper, connection management, and its
  storage/transport integration.
- **Composition package:** combines backend instances using only the public
  contract. Owns routing, cross-propagation, aggregate observations, failure
  handling, and child lifetimes; needs no Automerge or Subduction internals.

The existing adapter implementations can become subpath exports of the legacy
package. Browser consumers must not pull in Node filesystem or server WebSocket
code. Temporary forwarding packages are a release/migration option, not a reason
to retain legacy implementations in core Repo.

Example usage, with provisional names:

```ts
const defaultRepo = new Repo() // owns a default Subduction backend

const backend = new LegacyBackend({
  storage,
  network,
  shareConfig,
})
const repo = new Repo({ backend })
```

Subduction signers, endpoints, policies, and tuning options likewise belong to
`SubductionBackend`, not `RepoConfig`. The injected object is sedimentree-shaped,
despite the generic `backend` name.

## Backend composition

Composition is a design requirement, not something to try after freezing the
interface. The simplest test is whether a third-party package can implement a
legacy/Subduction bridge using only the contract available to Repo.

The first composite is a migration bridge, not a general routing framework.
Bridging is explicitly enabled and bidirectional for all eligible 16-byte-ID
documents. Native Subduction IDs stay in Subduction. Per-document route selection
and primary/quorum write policies are deferred. Ephemeral messages follow the
same routes as document history.

Illustrative configuration, with policy names still provisional:

```ts
const repo = new Repo({
  backend: new CompositeBackend({
    children: { legacy, subduction },
    bridge: "bidirectional",
  }),
})
```

### Data movement and availability

For a sedimentree routed to both children:

- Local writes are submitted to both.
- Opening observes both children and presents their combined history to Repo.
- Records learned from either child are ingested into the other, so a
  legacy-only peer can exchange edits with a Subduction-only peer. Merely
  multiplexing reads and fanning out local writes is not sufficient.
- Forwarding is driven by backend observations, not handle mutation events or
  private storage callbacks. Repo must not have to echo received history back
  into the composite for it to reach the other protocol.

The composite tracks record/history coverage and in-flight work per child.
Record imports must be idempotent; self-echoes and equivalent fragment
repackagings must reach a fixed point rather than circulate indefinitely.
Deduplication cannot rely only on blob bytes or an unbounded set of every record
ever seen. The metadata/equivalence contract must make this implementable
without decoding Automerge documents in the composition package.

Preserve child-scoped loading, synchronization, failure, and remote-head
observations. A complete initial snapshot from any one child or remote source
is sufficient for Repo readiness, once Repo has processed and verified its
checkpoint. Other children may still be loading; a missing or failed child must
not erase healthy data. The aggregate initial-load checkpoint follows settlement
of the participating child loads and records failures, rather than treating them
as empty stores. Repo does not need to wait for this aggregate checkpoint if a
complete copy is already available. Do not promise an atomic snapshot across
independent stores. Absence, unlike readiness, requires all relevant child
lookups to settle, not whichever responds first.

### Discovery and inbound demand

Per-sedimentree `open`/`store` alone is not enough for a general bridge. A child
can receive data or a request for a sedimentree that Repo has never opened.
The common contract therefore also needs:

- Coordinated enumeration of existing sedimentree IDs and observation of new
  IDs/activity, without eagerly materializing application documents. Collection
  observation uses bounded pull/replay and explicit rescan, like document
  observation; the composite reconciles history with bounded background work.
- Notification of unresolved inbound demand, with a bounded way to allow the
  composite to obtain data from another child before the requesting child
  concludes that the sedimentree is unavailable.

A plain discovery event does not solve the second requirement: a legacy child
could otherwise send `doc-unavailable` before the composite has loaded data
already present in Subduction. The demand-resolution handshake must handle
recursive requests, deadlines, cancellation, and the absence of a resolver.
Whether this is a resolver registration or a deferrable observation is an API
detail to validate in the real-backend milestone (1b), before bulk extraction.

The composite retains bridge interest for routed documents independently of
application watches. Closing a Repo watch must not disable cross-protocol
forwarding. On restart, inventory and history reconciliation must recover missed
cross-propagation rather than rely solely on notifications from the previous
process. Matching inventories of IDs alone do not prove matching history.

### Durability and partial failure

The initial write policy requires all participating children: a composite
`store` resolves only once every selected child store has settled successfully,
without waiting for either network. A child's failure does not undo successful
writes to another child. Drain all writes, report child-attributed aggregate
failures, and permit retries without duplicate effects. There is no distributed
transaction.

`flush` first drains the cross-propagation work captured by its barrier, then
flushes the affected children. A child flush alone cannot cover work still in a
composite queue. Failed forwarding must remain retryable or reconstructible from
a surviving persisted copy; it must not be marked complete merely because the
source emitted data. Keep local durability separate from successful delivery to
both networks.

A later primary-store or quorum policy is possible, but must explicitly define
acknowledgment and recovery guarantees. Do not silently downgrade to "whichever
child succeeded". The composite's persistence declaration must truthfully
reflect its configured guarantee, including memory-only children.

### Routing, identities, and ephemerals

The initial format convention is carried by the logical document ID: a 16-byte
ID denotes ordinary, unencrypted Automerge data and is eligible for legacy
routing. Every other ID length is excluded from legacy. The Subduction wrapper's
32-byte padding does not change that classification; see
[Document ID mapping](#document-id-mapping). No format-negotiation protocol or
general capability registry is needed initially. Legacy still validates payloads
and rejects malformed or unsupported data; the ID convention is not proof that
the bytes are valid.

Enabling the migration bridge is an explicit authorization choice. Permission to
receive data on one network is not automatically permission to publish it on
another. Child policies still apply, and matching document or peer IDs do not
establish authorization or identity equivalence.

Scope backend observations and peer identities by their child provenance. A
legacy storage UUID and a Subduction verifying key remain distinct.

The first usable migration bridge includes best-effort ephemeral relay, not just
document history. Ephemeral fanout and cross-protocol relay need stable message
identity across children and forwarding hops. A bytes-only publish API that lets
each child mint an unrelated identity is insufficient. The common envelope must preserve
message ID and origin separately from the authenticated transport sender; see
[Ephemerals, remote identity, and API migration](#ephemerals-remote-identity-and-api-migration).
Relay/deduplication must work in a topology with multiple composite bridges, not
just with one relay. Payload equality is not a substitute for message identity.

### Ownership and deletion

The composite owns its children and its forwarding work. It uses isolated child
stores/namespaces initially; shared-storage and shared-close ownership require
an explicit design rather than assuming the stores can safely overlap.

Deletion fences forwarding for the sedimentree before deleting it from children,
so one child cannot immediately repopulate another during teardown. Partial
deletion failures must be surfaced and reconciled; this is still local deletion,
not a network-wide tombstone. Close must quiesce forwarding, drain captured work,
and close every child even if another fails. None of this should require Repo
to inspect the composition or perform child-specific cleanup.

## Sedimentree data model

The boundary carries plain values representing:

- **Sedimentree IDs.** Independent of Automerge URLs and document ID encodings.
- **Commit IDs.** Logical history identifiers, not necessarily hashes of the blob
  bytes after a transformation such as encryption.
- **Loose commits.** Commit ID, parent commit IDs, and blob bytes.
- **Fragments.** Head, boundary, checkpoints, and blob bytes, retaining the
  metadata needed by the sedimentree representation.
- **Batches.** Multiple commit/fragment records belonging to one sedimentree.
- **Heads.** Sets of logical commit IDs, not Automerge's URL-encoded heads.

Do not use WASM-owned objects such as `CommitInput` or `SedimentreeId` in public
signatures. Backend implementations convert between plain values and their
native representations.

The final types need a canonical encoding, validation rules, and explicit byte
ownership. Callers must not be able to mutate a buffer while it is being stored;
implementations must copy or define an ownership transfer, not rely on convention
across asynchronous calls.

### Logical identity, representation, and coverage

The logical record key is `(sedimentree ID, record kind, commit ID)`. For a loose
commit the last component is its own ID; for a fragment it is the fragment head.
A loose commit and a fragment with the same head remain distinct records.
`CommitId` is an opaque, caller-supplied 32-byte identifier. The Automerge
translation uses its change hash, not a hash recomputed from the stored blob.

This matches the published upstream implementation: `sedimentree_core` 0.14.2
uses separate commit and fragment maps keyed by `CommitId`, and separate sets
for their synchronization fingerprints. See the [CommitId definition][commit-id]
and [map/fingerprint implementation][sedimentree-identity].

Logical identity is not exact representation equality. Keep boundary/checkpoint
metadata and blob identity distinct from the logical key. Upstream storage uses
content-addressed representations and permits conflicting payloads under the
same logical ID; the in-memory sedimentree uses a lower-content-digest tiebreaker
when such variants are inserted. That is conflict resolution, not proof of
semantic equivalence. See the [storage contract][subduction-storage] and
[tiebreaker implementation][sedimentree-tiebreaker].

The integration must validate duplicate/conflict behavior against its selected
backend versions. A set of previously seen heads is not sufficient validation of
arbitrary incoming representations. Likewise, identifying a fragment does not
by itself prove which other records its history covers. Composition must handle
equivalent repackagings using sedimentree metadata rather than blob equality or
Automerge decoding; physical reclamation remains backend-owned.

[commit-id]: https://docs.rs/sedimentree_core/0.14.2/sedimentree_core/loose_commit/id/struct.CommitId.html
[sedimentree-identity]: https://docs.rs/sedimentree_core/0.14.2/src/sedimentree_core/sedimentree.rs.html#40-51
[subduction-storage]: https://docs.rs/crate/subduction_core/0.18.2/source/src/storage/traits.rs
[sedimentree-tiebreaker]: https://docs.rs/sedimentree_core/0.14.2/src/sedimentree_core/sedimentree.rs.html#25-38

### Document ID mapping

Keep URL parsing outside the backend contract. Plain logical IDs retain their
byte length so backends and the composite can apply the routing convention
without importing Repo's URL types. Existing Automerge URLs must continue to
identify the same documents when using the legacy backend.

The initial mapping is:

- **16 bytes:** a legacy-compatible, unencrypted Automerge document. This applies
  to all 16-byte IDs, not only syntactically valid UUIDs. The Subduction backend
  embeds it as the original 16 bytes followed by 16 zero bytes.
- **32 bytes outside that reserved range:** a native Subduction ID, preserved
  without truncation and never routed to legacy. New native IDs are expected to
  be Ed25519 public keys.
- **32 bytes ending in 16 zero bytes at the Subduction boundary:** reserved
  exclusively for the legacy embedding; reverse it to the first 16 bytes. Native
  ID creation must exclude this range, even when IDs are generated as keys.
- **Other lengths:** never route to legacy. Support for such IDs from `idFactory`
  needs an explicit lossless mapping before use; reject unsupported lengths
  rather than silently padding, truncating, or introducing collisions.

Padding/unpadding belongs inside the Subduction backend. A caller cannot claim a
reserved-range value as a distinct native ID. This replaces the branch helper's
unconditional truncation with an unambiguous, lossless round-trip for supported
logical IDs.

## Backend operations

The following is a **surface sketch**, not a complete TypeScript definition.
The batch, event, result, and ephemeral-envelope types stand for the data and
observations described in this document. `SedimentreeId` here is a plain contract
ID, not Subduction's WASM class. Collection observation is included for external
composition; the associated demand-resolution handshake is not yet specified.

```ts
interface SedimentreeBackend {
  readonly persistence: "memory" | "persistent"

  observeCollection(): AsyncIterable<CollectionObservation>
  open(id: SedimentreeId): SedimentreeSession
  store(id: SedimentreeId, batch: RecordBatch): Promise<void>
  flush(ids?: readonly SedimentreeId[]): Promise<void>
  deleteLocal(id: SedimentreeId): Promise<void>
  close(): Promise<void>
}

interface SedimentreeSession {
  readonly events: AsyncIterable<SedimentreeEvent>

  synchronize(options?: { signal?: AbortSignal }): Promise<SyncRoundResult>
  publishEphemeral(message: EphemeralEnvelope): Promise<void>
  close(): Promise<void>
}
```

A session expresses local interest in one sedimentree; it is not a network
connection. Opening establishes observation, starts local loading, and registers
interest for automatic synchronization. `synchronize()` explicitly requests a
bounded round, for example after a user-requested retry; it is not required after
every local edit.

Observation is a pull-driven async stream with bounded replay and an explicit
`rescan-required` outcome when a consumer falls behind. Async iteration must not
hide an unbounded push queue. Initially, sequence positions are internal and
process-local; durable, externally managed cursors are not required. Event
spelling and the exact reset handshake remain implementation details to validate.

### 1. Initial loading and live observation are one operation

A session must provide a gap-free transition from existing local data to live
updates. Do not expose independent `loadBlobs()` and `subscribe()` calls that
leave callers responsible for coordinating a race.

The event sequence includes:

- Record batches, with an explicit initial-load phase.
- A local-load-complete checkpoint.
- Subsequent record batches and synchronization observations.
- Remote-head observations and ephemeral messages.
- Typed failures, with operation and retryability information.
- An explicit rescan requirement if the bounded replay window is exceeded.

At `open`, the implementation establishes a finite initial cut and a watch.
Initial batches describe enough data to reconstruct that cut. Subsequent history
is delivered as updates, or recovered through an explicitly signaled rescan if
the consumer falls behind. Overlap and duplicate delivery are permitted; silent
history loss is not. Concurrent compaction must not remove records needed by the
initial enumeration before their replacements are covered by the stream.

The initial checkpoint is not delayed indefinitely by ongoing writes or an
unreachable network. It means local enumeration is complete, not that all remote
data has arrived. A new watch must also be able to observe records previously
stored by this process; suppressing self-echoes must never hide data from another
watch.

This interface is implemented by the backend itself. Subduction's existing
storage wrapper provides gap-free observation and is the initial implementation
path, despite being somewhat clunky. Keep it private to the backend: callers do
not supply or listen to storage to observe data. A future upstream data-event or
pull API can replace it without changing the caller-facing boundary.

### 2. Storing, persisting, and replicating are separate

Guarantees for `store`:

- Resolution means the history represented by all submitted records is
  recoverable under the backend's declared persistence model. A persistent
  backend has completed its local durability operation; an in-memory backend
  promises only process-local state.
- It does not wait for a peer, a sync round, or remote acknowledgment.
- A successful write schedules propagation according to backend policy, even if
  the caller has no open session for that sedimentree.
- Repeating an equivalent batch is safe. A failed write may have partially
  persisted; callers must be able to retry the whole batch.
- Invalid metadata or unsupported payloads reject rather than silently becoming
  missing data. Exact duplicate/conflict handling must respect the distinction
  between logical identity and representation equality, with conformance tests.

All-or-nothing transactions are not required of legacy storage adapters. However,
persistence must never acknowledge a fragment replacement while losing both its
old representation and its replacement.

Event delivery may race the `store` promise. Consumers must tolerate self-echoes,
repeated records, and overlapping fragments without duplicate application events
or write loops. Data availability is not itself a local-durability receipt; a
backend may surface remote data before its persistence completes.

`flush(ids)` captures and drains outstanding local persistence work for the
specified sedimentrees, or all sedimentrees. Work accepted before the call is
included; subsequent edits need not keep the barrier open forever. It does not
wait for network synchronization. Concurrent calls need defined barriers, not a
requirement that the entire system become idle.

Repo may buffer work before submitting it to the backend. Consequently,
`Repo.flush()` must first capture and submit its own pending translation work,
then await backend persistence. Delegating directly to `backend.flush()` would
miss edits still sitting in a Repo-side throttle.

Drain all targeted writes before reporting failures, with bounded concurrency
and aggregated errors. Do not return on the first failure while other saves are
still running. "Durable" remains subject to the documented guarantees of the
underlying storage implementation; it must not imply an `fsync` guarantee an
adapter does not provide.

### 3. Report backend facts, not document readiness

Useful observations include:

- Local loading is pending, complete, or failed.
- Connection startup is pending or has settled; a peer set may be empty.
- A sync round completed with particular peers, reported no data, or failed.
- A peer advertised particular heads, and the data for a reported completed
  synchronization checkpoint has been delivered through the stream.

A sync result must not imply that all peers were contacted or that anyone has
durably stored our data unless the protocol actually provides that evidence.
No peers, a negative response, denial, and a timeout are not interchangeable.
The legacy wire protocol can conceal denial as `doc-unavailable`; the adapter
must not invent a distinction it cannot observe.

Synchronization checkpoints must be ordered after their associated data events.
Resolving `synchronize()` does not mean the stream consumer has applied those
events yet. Repo derives readiness only after processing the relevant checkpoint
and asking the CRDT translation whether its materialized state satisfies it.

**A complete initial snapshot from any one source is sufficient for readiness.**
Complete means relative to that source's initial checkpoint, not globally up to
date with all peers:

- A usable, complete local load can make Repo ready without waiting for network
  synchronization.
- Otherwise, reaching one remote peer's advertised initial heads is sufficient,
  once Repo has processed the corresponding stream checkpoint and verified the
  history is present. Do not wait for all peers or for synchronization to stop.
- The same rule applies to children of a composite. Other sources may continue
  loading or synchronizing in the background.
- With no usable data, wait for startup and relevant source lookups to settle
  before reporting unavailable. Successful empty local lookups plus no peers, or
  all consulted sources reporting no data, can establish current unavailability;
  a later peer can supply the document. Lookup failures and timeouts are errors,
  not proof of absence.

Explicitly test initial hydration: receipt of an arbitrary first blob does not
satisfy the rule. For example, receiving `A` from a peer advertising the history
`A -> B -> C` is insufficient until the advertised checkpoint at `C` is satisfied.

On main, `DocumentQuery` becomes ready whenever the handle has non-empty heads,
regardless of pending sources. Meeting this guarantee requires staging initial
application or changing that readiness predicate; adding another pending source
alone will not prevent premature readiness.

A watch remains useful after a retryable failure. Terminal failures end that
watch clearly; they must not leave it silently pending forever.

### 4. Fragment compaction preserves history

The CRDT translation decides how to encode fragments. The backend maintains a
sufficient sedimentree representation and may reclaim provably redundant local
records only after replacement data is persisted.

For the Subduction backend, physical reclamation should be owned by Subduction,
not a Repo or wrapper-side `removeBlob()` loop. Do not port the branch's strategy
of inferring deletion candidates from the current application document: a
replacement visible in Automerge may not yet be persisted, and a partially
hydrated document may omit records it still needs. Unread or undecoded records
must remain safe, as must concurrent enumerations.

The initial scaffold may create and store fragments while retaining superseded
records. Fragment formation and physical cleanup are separate operations.
Storage growth is preferable to unproven deletion; wrapper-side reclamation is
out of scope initially. Validate any later Subduction-owned reclamation against
persisted coverage and reader safety, adding upstream facilities if necessary.
This does not require replacing legacy's existing snapshot/incremental storage
compaction with a new sedimentree store.

### 5. Backpressure and resource limits

Opening many documents or receiving a large history must not create unbounded
storage reads, writes, listener callbacks, or buffered blobs.

The implementation must bound work and delivery queues. Consumers pull bounded
batches, and a bounded replay window covers intervening updates. If that window
is exceeded, report `rescan-required` rather than silently dropping history or
buffering indefinitely. This applies to document and collection observation,
including the legacy implementation.

On rescan, Repo or the composite restarts observation from a fresh finite cut.
Merge recovered history into existing state; do not clear the document, lose
pending local edits, or treat an incomplete old stream as a satisfied checkpoint.
The backend must retain the history needed for recovery, not discard the only
copy when dropping replay entries. Status observations may be coalesced.
Ephemerals are best-effort and are not recovered by history replay/rescan.

Use metadata-first extraction and bundle only new records. Avoid serializing
every fragment on each edit, applying one handle update per received blob, or
performing full-collection work for every per-document event.

### 6. Lifecycle and ownership

A backend instance has one owner, either Repo or a parent composite backend.
Repo shutdown closes its injected or default backend; a composite closes its
children. Shared ownership and cyclic composition are not
implicit and would require a separate lifetime contract. Multiple sessions for
one sedimentree have independent lifetimes, even when the backend shares work
between them. Ending stream consumption must release its watch, not leave an
unread queue growing indefinitely.

An abort signal on `find` or a synchronization wait cancels that caller's wait,
not other sessions or already accepted persistence. Session close, rather than
cancelling a wait, is how the caller releases its interest.

| Operation           | Meaning                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session close       | Release local observation/interest; stop future delivery and release listeners. Do not delete data or cancel already accepted writes.                                                     |
| Repo cache eviction | Stop local document work, preserve pending edits, close its watch, then release handles/query bookkeeping. Remote replication may continue inside the backend.                            |
| Local deletion      | Quiesce that document's local producers, invalidate existing watches, drain/order earlier work, and remove locally retained data and relevant protocol state. Not a replicated tombstone. |
| Backend close       | Reject new work, quiesce producers/reconnect loops, drain accepted persistence, stop delivery, disconnect transports, and release storage/WASM resources.                                 |

`Repo.delete(id)` returns `Promise<void>`. It invalidates existing handles and
stops their producers immediately, before awaiting local persistence operations.
The promise resolves only after local data and relevant protocol state have been
removed from the participating backends, and rejects on deletion failure. This
replaces the current fire-and-forget storage removal.

Deletion needs a generation/barrier rule: a load, save, or sync callback started
before deletion must not resurrect the old local generation. Reject new local
stores for that sedimentree while the deletion barrier is in progress. A later
explicit open or new remote request may reacquire it; permanently refusing it
requires a separate policy. Cache eviction needs the same protection against
late callbacks updating an obsolete handle, but must retain stored data.

Session and backend close should be idempotent. Cleanup must still run after
failures. Backend close should surface failures after attempting all cleanup;
Repo can retain its documented best-effort shutdown policy, with explicit
`flush()` available to callers that need to observe persistence errors.

Normal shutdown has no unconditional forced timeout. Repo first quiesces local
producers and submits/drains its pending translation work; backend close drains
accepted persistence before releasing the resources it needs. An uncancellable
storage operation that hangs indefinitely can therefore keep shutdown pending.
A separate forced-close policy is deferred. Do not silently drop writes or report
a completed durability barrier merely because a timeout expired.

## Automerge translation

This layer is responsible for:

1. Extracting commit/fragment metadata from an Automerge document.
2. Encoding only records not already represented in the backend.
3. Applying incoming blobs in batches, preserving concurrent local edits.
4. Relating backend commit heads to Automerge history and readiness.
5. Converting document/URL identities to plain logical IDs. Subduction's native
   padding/unpadding remains inside its backend, not the CRDT translation.

Known backend records must be recorded before applying inbound data to a handle,
so the resulting handle events do not immediately write it all back. Local
writes need separate in-flight and acknowledged bookkeeping: a failed store must
remain retryable. Do not permanently mark records saved before persistence has
succeeded.

Initial local creation can continue to return a synchronous handle. Persistence
and backend initialization happen asynchronously, with errors visible through
flush/status reporting. `clone` and `import` must submit their complete intended
history; they must not accidentally retain only changes after a temporary empty
document. Loading a document without changing it must not rewrite all its data.

The scaffold deliberately pins Automerge 3.3.2, upgrading main's 3.2.6 dependency
for the public experimental `getFragmentMetadata` and `bundleFragmentMetadata`
APIs also used by the inspected Subduction branch. Keep the upgrade covered by
Repo regression tests; do not import private WASM internals. Fragment bundles
must not be forwarded unchanged to older Automerge runtimes through legacy sync.
The translator normalizes full Automerge fragment checkpoint hashes to the
sedimentree model's 12-byte prefixes, distinct from full readiness-checkpoint
heads.

Keep this work separate from generalizing the public document API. The backend
contract should admit another CRDT without importing Automerge, even while Repo
itself still has an Automerge-only implementation.

## Legacy backend translation

The legacy backend is intentionally an Automerge-specific implementation of the
sedimentree contract. It is not an opaque-blob sync engine.

### Outbound flow

```text
Repo Automerge state
  -> commit/fragment batch
  -> legacy backend applies blobs to an internal Automerge.Doc
  -> existing legacy storage and per-peer sync
```

### Inbound flow

```text
legacy storage load or received sync message
  -> internal Automerge.Doc
  -> commit/fragment batch and synchronization observations
  -> backend watch
  -> Repo Automerge state
```

The backend should use the existing storage format as its source of durable
truth, synthesizing sedimentree records from it. Avoid maintaining a second,
independent sedimentree store just to emulate Subduction. Promise semantics must
account for the fact that persistence stores reconstructible history rather than
necessarily preserving the exact incoming record packaging. In particular,
verify recovery of records with missing dependencies: materialized heads alone
are not proof that all submitted history was persisted.

A preliminary check with main's Automerge 3.2.6 confirmed this risk: accepting a
change with a missing predecessor leaves heads unchanged; full save/load retained
it, while `saveSince` from the existing heads did not. Current `saveDoc()` also
skips unchanged heads. Add a regression test against the deliberately selected
Automerge version before reusing this persistence path for backend `store`.

This means the common contract preserves history/coverage, not exact enumeration
of every record ever submitted. A later read may return an equivalent compacted
representation. A backend must still supply enough data and metadata to satisfy
the requested history; it cannot return only the current materialized value.

The existing `DocSynchronizer` depends on a `DocHandle` and `DocumentQuery`.
Refactor that dependency into a small private document-access/availability port
while preserving its protocol decisions. Do not instantiate a nested Repo or
require the backend to reach into public handles to function. The existing
source-priority coordination can remain internal to the legacy backend during
extraction; it is not part of the sedimentree contract.

`CollectionSynchronizer` currently discovers unknown documents by calling
Repo's `ensureQuery`. Replace that with backend-owned internal document
registration. Preserve inbound discovery, sync-server operation, and sharing
without requiring an application watch. Application-facing discovery is an
ID-only observation driven by the backend, not a prerequisite for accepting data
and not a reason to create a Repo query or public handle.

Retain and test:

- Legacy network messages, handshakes, and interoperability with an unmodified
  legacy peer.
- Existing snapshots/incrementals, storage identity, and persisted sync states.
- Announce/access policies, denylist behavior, and policy reevaluation.
- Waiting for storage/network initialization and supplier heads before answering
  requesting peers.
- Ephemeral relay/deduplication and reconnection/cache-eviction behavior.
- Remote-head gossip and bounded storage/policy work.

The translation may require two Automerge materializations for a watched
document: one in Repo and one in the legacy backend. Accept that as an explicit
initial cost, measure it, and avoid introducing a backdoor that passes
`Automerge.Doc` across the common interface to optimize it away. Server-only
internal documents and their derived metadata must be evictable and reloadable.

The backend accepts only 16-byte logical document IDs, which designate ordinary,
unencrypted Automerge data. Reject other IDs before attempting legacy storage or
sync, and reject malformed/unsupported payloads predictably. This convention
replaces a generic format-capability negotiation API for the initial work; it
does not make arbitrary or encrypted CRDT payloads compatible with legacy.

## Subduction backend

Implement the same contract around Subduction without moving the branch's entire
`SubductionSource` into core Repo.

Responsibilities include:

- Mapping plain records/IDs to Subduction values and releasing WASM resources.
- Coordinating initial enumeration and subsequent data notifications.
- Local persistence, retaining redundant records until Subduction-owned
  reclamation is available and validated.
- Connections, subscriptions, retry scheduling, and bounded synchronization.
- Remote-head, connection, error, and ephemeral observations.

Automerge fragment extraction and handle mutation move to the translation layer.
Use the existing storage wrapper for gap-free observation initially, keeping its
callbacks private to this backend. A cleaner upstream observation API is future
work, not a prerequisite for the scaffold. Physical reclamation should likewise
be supplied by Subduction rather than recreated in the wrapper.

Blob transformations need a separately reviewed placement, for example a
sedimentree-layer decorator. Do not conflate logical commit identity with the
transformed blob's digest, mix plaintext/ciphertext storage namespaces, or delete
unreadable blobs as if they were redundant. The initial integration should not
promise encrypted operation through the legacy backend.

## Ephemerals, remote identity, and API migration

Ephemeral messages cross the backend boundary in a plain `EphemeralEnvelope`
containing payload bytes, stable message identity, and origin metadata.
Application serialization can remain above it. Allocate identity once per
broadcast, above any fanout; receiving and forwarding the envelope must not mint
a new message identity. Map existing legacy session/count stamps and Subduction
payload envelopes without conflating a relayed origin claim with authenticated
transport identity. The exact encoding and mappings need interoperability tests.

Delivery is best-effort, not persisted or recoverable through rescan. Each
concrete backend owns its protocol-specific relay/loop suppression. When the
migration bridge is enabled, the composite also deduplicates and relays across
children for the same eligible documents as persistent history. A standalone
Subduction backend must not depend on a legacy synchronizer to do this. Preserve
document-scoped broadcast behavior, including sub-handle fanout, without
promising reliable delivery.

Connection/session identity, a durable legacy storage ID, and a Subduction
verifying-key identity are different concepts. The observation types should
preserve those distinctions rather than cast all three to `StorageId`.
Remote-head observations are claims about known history, not proof of durable
remote backup. Persisting/replaying observations and legacy gossip belong to the
backend; Repo needs only the generic view required by its document API. Initially,
protocol-specific peer, connection-identity, and storage-identity APIs live on
the corresponding backends. Any remote-head observations retained on Repo must
preserve identity kind and backend provenance; there is no invented single
`repo.peerId` for a composite.

Public API migration should be explicit:

| Current API                                                                 | Proposed destination                                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `storage`, `network`, `isEphemeral`, legacy sharing/gossip/tuning options   | Legacy backend construction/configuration.                                                                 |
| Subduction signer, endpoint, timeout, policy options                        | Subduction backend construction/configuration.                                                             |
| `networkSubsystem`, `storageSubsystem`, `synchronizer`, peer metadata table | Remove from core Repo; expose backend-specific diagnostics only where needed.                              |
| `storageId()`, `getStorageIdOfPeer()`, `subscribeToRemotes()`               | Legacy backend APIs or explicit compatibility facade.                                                      |
| `shareConfigChanged()`                                                      | Backend-specific policy invalidation; not a generic signal for retrying decryption.                        |
| `peers`, `peerId`                                                           | Backend-specific APIs initially; a composite has multiple scoped identities, not one synthetic peer ID.    |
| Remote-head APIs                                                            | Generic observations only where useful to the document API, preserving identity kind and child provenance. |
| `flush`, cache eviction, shutdown                                           | Remain Repo operations, implemented through translation barriers and backend lifecycle.                    |
| `delete`                                                                    | Remains a Repo operation; invalidates handles immediately and returns a promise for local removal.         |
| Document progress and metrics                                               | Preserve useful behavior; stop exposing legacy source names/protocol state as the generic model.           |
| Document discovery                                                          | ID-only backend-driven observation; applications explicitly call `find()` if they want handles.            |

`new Repo()` constructs a default Subduction backend, never legacy machinery.
This permits a concrete Subduction dependency and its WASM initialization in the
Repo package for now. Explicit backend injection replaces the default rather
than constructing both. Backend-specific configuration stays on backend
constructors; the exact default signer, storage, and connection setup needs
implementation validation. Browser entrypoints must still exclude Node-only
adapters. A core independent of both Automerge and Subduction is future work.

## Implementation plan

### 1a. Build the minimal executable scaffold

This is the first deliverable, not the complete real-backend validation milestone.
The foundation is now implemented in the private workspace packages
`automerge-repo-sedimentree` (plain contract and testing-only memory backend) and
`automerge-repo-sedimentree-automerge` (pure translation). Tests exercise their
round-trip, checkpoint ordering, and rescan boundary. Repo's public constructor
and existing legacy orchestration are unchanged. The internal document controller,
Repo readiness gate, and pending/in-flight/acknowledged write barriers remain the
next integration step; this does not mark all of phase 1a complete.

- Introduce provisional plain contract types: logical IDs, record metadata and
  bytes, checkpoints, failures, rescan signaling, and ephemeral envelopes. Keep
  the contract independent of Repo, Automerge, and Subduction runtime types.
- Verify the required Automerge APIs and dependency update independently, then
  build the small reusable translation module.
- Build a deterministic in-memory backend/test double exercising load/watch,
  bounded replay/rescan, idempotent store, flush, deletion, and session/backend
  lifetime. It is test infrastructure, not Repo's user-facing default.
- Connect translation and document readiness through a small internal controller.
  `DocumentSource` may be temporary scaffolding, not the public backend contract.
- Test synchronous creation without a later edit, edits, complete initial load,
  session/cache reopen, no-op reload without write-back, duplicate delivery,
  edits during loading, retryable store failures, and flush of pending translation
  work. Exercise readiness from one complete source and recovery after rescan.

Keep real networking, wholesale adapter movement, production composition, and
wrapper-side reclamation out of this first patch. Types may evolve; a fake that
preserves exact records does not prove cross-backend equivalence or durability.

### 1b. Validate real backends and composition before bulk extraction

- Implement experimental legacy translation for create, edit, persist, reload,
  and two-peer sync; check interoperability with an unmodified legacy Repo.
- Verify durable recovery of out-of-order records with missing dependencies.
- Exercise the same operations with a thin Subduction wrapper using the existing
  storage observation path and no wrapper-side reclamation.
- Compose them using only public interfaces. Validate edits in both directions,
  an unopened legacy-compatible document requested on one side but stored on the
  other, and recovery after one child store fails.
- Prove that equivalent fragment/loose-commit representations reach a forwarding
  fixed point without Automerge decoding in the composite. Matching logical keys
  alone are not a substitute for testing representation/conflict handling.
- Validate stable ephemeral identity mappings through a mixed-protocol bridge.

This milestone is a design test, not a wholesale extraction. It must expose an
impossible contract, duplicate-materialization costs, or missing Subduction
facilities before freezing the interface or moving all the legacy machinery.

### 2. Extract main's legacy machinery

- Move storage, network, synchronization, gossip, and adapter implementations to
  the legacy package, retaining wire/storage formats and protocol regression
  tests.
- Introduce private document access inside that package instead of depending on
  Repo handles/queries.
- Wire Repo to the sedimentree translation and injected backend.
- Cover lifecycle, ephemerals, policies, and observations—not just document bytes.
- Remove legacy constructors, message routing, and subsystem exports from core.
- Update examples, templates, adapter imports, and framework integration tests.

Keep mechanical movement and behavior changes separable in review. Temporary
internal scaffolding is acceptable; a permanent Repo-level dual-protocol path is
not. Concurrent operation is implemented through the composite backend.

### 3. Implement the Subduction backend selectively

- Port or reimplement only the connection, persistence, and synchronization
  pieces needed by the contract.
- Move relevant branch regression tests to the new boundary.
- Encapsulate the existing storage observation path; replace it upstream when a
  cleaner API is available, without blocking initial integration.
- Validate fragments, late-arriving data, retry behavior, and shutdown under real
  Subduction transport/storage implementations. Keep redundant records until
  Subduction-owned reclamation satisfies the coverage and persistence guarantees.
- Wire default Subduction construction and explicit backend override without
  importing legacy machinery or Node-only adapters into browser entrypoints.

### 4. Implement and validate the composition package

- Combine backend instances without importing their private APIs or core Repo.
- Implement the simple migration policy: explicitly enabled bidirectional
  bridging for 16-byte-ID documents, including ephemerals; native Subduction
  IDs are never forwarded to legacy.
- Implement inventory/demand coordination, cross-propagation, and child-scoped
  observations, preserving per-child checkpoints and errors. Require every
  selected child store to succeed before acknowledging a composite write.
- Cover forwarding recovery, partial write/delete failures, bounded work,
  teardown, and mixed-protocol ephemeral loops.
- Test with real legacy/Subduction implementations as well as fake children.
  Interface changes discovered here must remain generic, not Subduction-specific
  escape hatches.

### 5. Finish API and packaging migration

- Remove temporary adapters and dead source-priority/legacy configuration paths
  from core Repo once no longer needed.
- Document constructor/import changes and backend capability differences.
- Decide whether forwarding packages or a legacy constructor facade are needed.
- Verify browser/Node dependency boundaries and the absence of runtime cycles.
- Keep a dependency-free core, non-Automerge public document APIs, and E2EE as
  separate follow-up work.

## Test strategy and acceptance criteria

### Shared contract tests

Run against every backend for its supported payload format:

- Gap-free initial load plus watch, including writes before/while opening and
  concurrent fragment replacement.
- Batched and duplicate delivery; local self-echoes; out-of-order dependencies.
- Logical identity versus representation equality, including a loose commit and
  fragment sharing a head, and explicit handling of conflicting representations.
- Failed/partially persisted stores followed by idempotent retries.
- Local durability independent of network availability.
- Flush barriers under concurrent edits, bounded work, and aggregated failures.
- Session close, cache eviction/reopen, awaitable local deletion with late
  callbacks and partial failures, and backend shutdown with in-flight work.
  Uncancellable writes keep normal close pending until they settle.
- No peers versus startup pending versus negative response versus failed sync;
  later peer arrival and retry.
- Slow consumers and large histories with bounded queues, explicit rescan after
  replay overflow, and recovery without loss of local edits or history.
- Remote-head checkpoint ordering and ephemeral sender/loop semantics.
- Lossless 16/32-byte ID conversion, reserved-range enforcement, exclusion of
  non-16-byte logical IDs from legacy, and predictable rejection of unsupported
  ID lengths or malformed/unsupported payloads.

### Composition tests

Run the composite through the shared contract suite and add mixed-topology tests:

- Legacy-only and Subduction-only peers exchange edits through a composite,
  including remote changes never echoed back by Repo.
- A remote request discovers history stored only in the other child, without an
  application handle or premature `doc-unavailable` response.
- Child inventories diverge on startup, then reconcile without losing history.
- Duplicate records and different equivalent fragment packagings stop
  circulating; multiple bridges and reconnects do not cause write storms.
- One child's complete initial snapshot makes Repo ready while another loads or
  fails; child provenance and synchronization checkpoints remain accurate.
- Partial store failures, retry, restart, and flush cover outstanding forwarding,
  not just operations already submitted to children.
- Ephemeral identities survive fanout and relay; identical payloads from distinct
  broadcasts are not incorrectly deduplicated.
- Bridging is explicitly enabled and respects child policies; native Subduction
  IDs never enter legacy, and unsupported payloads fail predictably.
- Closing application watches does not disable forwarding; discovery itself
  never creates public handles.
- Cache eviction, deletion, and shutdown cannot leave forwarding loops, drop
  acknowledged work, or resurrect an old local generation.

### Repo behavior tests

Use a deterministic backend to test translation and public behavior without
network machinery: synchronous create, clone/import/export, changes, views and
fixed-head queries, initial hydration, sub-handles, progress, broadcasts, and
no-op reloads. Ensure changes made during load/save are retained and initial
creation is persisted even if there is no later edit. Cover default Subduction
construction versus explicit backend injection without starting both. Test
immediate handle invalidation with awaitable deletion, initial readiness from
one local or remote checkpoint, and rescan merging without clearing local state.

Retain useful tests from main's `Repo.test.ts`, `DocumentQuery.test.ts`,
`StorageSource.test.ts`, `SharePolicy.test.ts`, `EphemeralMessages.test.ts`,
`remoteHeads.test.ts`, and storage/network/synchronizer tests. Move tests that
inspect protocol internals into the legacy package rather than retaining public
escape hatches solely for those tests.

Select branch regression cases from `test/subduction/`, especially
`BlobLoadDedup.test.ts`, `AttachStorm.test.ts`, `SaveResilience.test.ts`,
`ShutdownRace.test.ts`, `SubductionEvents.test.ts`, and topology/transport tests.
Port the behavior being protected, not incidental assertions about private state
in the old `SubductionSource`.

### Completion criteria

- Repo document orchestration has no legacy wire messages, adapter construction,
  or sync-state persistence. The Repo package may depend on Subduction for
  default construction; all document work crosses the common contract.
- `new Repo()` owns a default Subduction backend; injecting another backend does
  not initialize an additional default backend. Dependency-free core packaging
  is not a completion requirement.
- Concrete and composite backends work through the same sedimentree-level
  contract with no `DocHandle`, `DocumentQuery`, or `Automerge.Doc` in it.
- Legacy-backed Repo reads existing storage and exchanges documents with an
  unmodified legacy peer.
- Subduction-backed Repo works without any legacy synchronizer, including
  ephemeral messages and remote-head observation.
- One Repo can use both protocols through an external composite backend. The
  composition package can bridge legacy-only and Subduction-only peers using
  only the common public contract, without changes to Repo. Its initial migration
  policy includes ephemerals and acknowledges writes only after every selected
  child store succeeds.
- Lifecycle and durability guarantees are tested, not inferred from timers:
  awaitable local deletion, draining shutdown without a forced timeout, and
  bounded observation with explicit rescan are part of the contract.
- A complete initial snapshot from any one source is sufficient for readiness;
  lookup errors are not treated as absence, and later data can restore availability.
- Replication/discovery does not require public handles, and backend-specific
  identities remain scoped rather than flattened into legacy storage IDs.
- The contract admits opaque payloads from another CRDT; legacy is limited to
  ordinary Automerge data under 16-byte logical IDs. No format negotiation is
  required for the initial integration.
- Repo and the Subduction wrapper do not independently reclaim superseded
  records. Retaining redundancy until Subduction can safely reclaim it is allowed.

## Remaining implementation decisions and validation

The initial architectural choices above are settled. The following are concrete
API details and feasibility checks for the scaffold and real-backend validation,
not reasons to reopen the agreed scope:

1. **Plain types and representation handling:** choose canonical ID/metadata
   encodings, byte ownership, and exact event/result types. Validate duplicate and
   conflict handling against the selected upstream versions, keeping logical
   identity distinct from representation equality and history coverage.
2. **Observation and readiness mechanics:** specify sequence/checkpoint correlation,
   bounded replay sizes, the rescan/reset handshake, and stream-consumption
   lifetime. Choose staging or an explicit readiness predicate so arbitrary first
   blobs cannot expose a partial initial load. Validate the existing Subduction
   storage observation path under races and slow consumers.
3. **Legacy feasibility:** select and test the Automerge dependency, fragment
   extraction, out-of-order persistence, wire/storage interoperability, and the
   private document-access port. Measure duplicate-materialization costs and
   ensure server-side documents can be evicted and reloaded.
4. **Composition mechanics:** choose resolver registration or deferrable inbound
   demand, including deadlines, cancellation, and recursion prevention. Validate
   inventory/history reconciliation, bounded forwarding, fixed-point behavior for
   equivalent repackagings, and recovery after partial store/delete failures.
5. **Ephemeral encoding and observations:** map legacy sender/session/count stamps
   and Subduction envelopes without changing identity on relay. Test multiple
   bridges, bounded deduplication, and separation of origin from authenticated
   sender. Specify the generic remote-head/progress view without flattening
   backend-specific identities.
6. **Default construction and ID creation:** choose the default Subduction signer,
   storage, connection, and initialization setup without leaking backend-specific
   settings into Repo orchestration. Specify how Repo creates native key-based
   IDs and handles `idFactory` values outside the supported 16/32-byte mapping;
   the reserved legacy range and exclusion from legacy routing are fixed.
7. **Packaging and migration:** choose package names, browser/Node entrypoints, and
   any temporary forwarding exports or legacy facade. Repo's default Subduction
   dependency is allowed; a dependency-free core is deferred.

Subduction-owned physical reclamation and a cleaner upstream observation API can
follow later. They are not prerequisites for the first scaffold. Use the
vertical slice and conformance tests to resolve the remaining details, not a
wholesale copy of the branch integration or main's incidental private interfaces.
