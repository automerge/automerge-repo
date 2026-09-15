# Subduction integration

**Status:** Design draft. The architectural direction below is agreed; API names
and signatures are proposals, not a finalized public interface.

## Summary

Replace Repo's built-in storage, network, and legacy synchronization machinery
with an injected **sedimentree backend**. Repo will exchange loose commits,
fragments, and opaque blobs with that backend rather than storage keys, network
messages, or Automerge sync states.

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
implementations based on CRDTs other than Automerge.

## Goals and non-goals

### Goals

- Inject one sedimentree backend into the Repo constructor.
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

- Implementing another CRDT, generic public handles, or a complete CRDT plugin
  registry. The first Repo-to-sedimentree translation remains Automerge-specific.
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

| Code | Current responsibility |
| --- | --- |
| `Repo.ts` | Constructs and wires storage, network, synchronizer, remote-head tracking, and document sources; owns queries and lifecycle operations. |
| `Document.ts`, `DocHandle.ts` | Own Automerge state, mutations, views, sub-handles, and document events. |
| `DocumentQuery.ts` | Combines document state and source observations into public loading/availability state. |
| `DocumentSource.ts` | Defines source attachment/detachment and availability priority. |
| `StorageSource.ts`, `storage/` | Load and save Automerge snapshots/incrementals; persist sync state and storage identity. |
| `synchronizer/`, `network/` | Run legacy sync, discover documents, evaluate sharing, and route messages. |
| `SyncStateTracker.ts`, `RemoteHeadsSubscriptions.ts` | Track remote heads, persist legacy sync state, and implement legacy gossip. |

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
lifecycle. Initially, document operations remain Automerge-specific.

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

### Packaging

Proposed responsibilities, with final package names still to be chosen:

- **Contract package:** plain sedimentree data types, backend interfaces, and
  shared conformance-test support. No Repo, Automerge, or Subduction runtime
  dependency.
- **Automerge translation module/package:** small reusable conversion helpers,
  shared by core Repo and the legacy backend. Depends on Automerge and the
  contract, not Repo. Avoid duplicating fragment extraction logic.
- **Core Repo:** public document API and translation orchestration. Depends on
  the contract and Automerge translation, not concrete or composite backends.
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
observations. A complete child checkpoint can provide useful data while another
child is still loading; a missing or failed child must not erase healthy data.
The aggregate initial-load checkpoint follows settlement of the participating
child loads and records failures, rather than treating them as empty stores.
Do not promise an atomic snapshot across independent stores. Likewise, absence
requires all relevant child lookups to settle, not whichever responds first.

### Discovery and inbound demand

Per-sedimentree `open`/`store` alone is not enough for a general bridge. A child
can receive data or a request for a sedimentree that Repo has never opened.
The common contract therefore also needs:

- Coordinated enumeration of existing sedimentree IDs and observation of new
  IDs/activity, without eagerly materializing application documents.
- Notification of unresolved inbound demand, with a bounded way to allow the
  composite to obtain data from another child before the requesting child
  concludes that the sedimentree is unavailable.

A plain discovery event does not solve the second requirement: a legacy child
could otherwise send `doc-unavailable` before the composite has loaded data
already present in Subduction. The demand-resolution handshake must handle
recursive requests, deadlines, cancellation, and the absence of a resolver.
Whether this is a resolver registration or a deferrable observation is an open
interface decision to validate in the first slice.

The composite may retain bridge interest independently of application watches.
The configured routing policy determines its scope; closing a Repo watch must
not accidentally disable a sync server's cross-protocol forwarding. On restart,
inventory reconciliation must recover missed cross-propagation rather than
rely solely on notifications from the previous process.

### Durability and partial failure

Start with a simple all-participating-children write policy: a composite `store`
resolves only once every selected child store has settled successfully, without
waiting for either network. A child's failure does not undo successful writes to
another child. Drain all writes, report child-attributed aggregate failures, and
permit retries without duplicate effects. There is no distributed transaction.

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

Bridging is an explicit routing/authorization choice. Permission to receive data
on one network is not automatically permission to publish it on another.
Child policies still apply, and the composite must not infer authorization or
identity equivalence from matching document or peer IDs.

Scope backend observations and peer identities by their child provenance. A
legacy storage UUID and a Subduction verifying key remain distinct. For trees
mirrored into both children, supported payloads are limited to their compatible
intersection: generic composition does not give the legacy backend support for
encrypted blobs or other CRDT formats.

Ephemeral fanout and cross-protocol relay need stable message identity across
children and forwarding hops. A bytes-only publish API that lets each child
mint an unrelated identity is insufficient. The common envelope must preserve
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

Record identity and blob identity must be distinguished. In particular, do not
assume a fragment is uniquely identified for every purpose by its head, or that
two transformed representations of one logical commit are interchangeable.
Canonical equality and conflict rules must be settled against the sedimentree
model before implementing deduplication.

### Document ID mapping

Keep URL parsing and document-to-sedimentree mapping outside the backend contract.
Existing Automerge URLs must continue to identify the same documents when using
the legacy backend.

The branch's `subduction/helpers.ts` pads document IDs to 32 bytes on the way in
and takes the first 16 bytes on the way out. That is not a reversible mapping for
general sedimentree IDs and must not become the general contract.

Define a compatibility mapping for existing UUID-based documents and a lossless
representation for native sedimentree IDs. Only reverse a legacy embedding when
it is actually in the legacy image; never silently truncate arbitrary IDs.
Resolve how non-UUID document IDs, including those from `idFactory`, are handled
before freezing the interface.

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

An async stream is proposed to make ordering and lifetime explicit. A callback
API is also possible if it provides the same guarantees. We should validate the
semantics before committing to either spelling.

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

At `open`, the implementation establishes a finite initial cut and a watch.
Initial batches describe enough data to reconstruct that cut, and every change
after it is delivered as an update. Overlap and duplicate delivery are permitted;
missing history is not. Concurrent compaction must not remove records needed by
the initial enumeration before their replacements are covered by the stream.

The initial checkpoint is not delayed indefinitely by ongoing writes or an
unreachable network. It means local enumeration is complete, not that all remote
data has arrived. A new watch must also be able to observe records previously
stored by this process; suppressing self-echoes must never hide data from another
watch.

This interface is implemented by the backend itself. A Subduction wrapper may
initially observe its storage internally, but no caller should have to supply or
listen to that storage to receive data. Prefer an upstream Subduction data-event
API once available.

### 2. Storing, persisting, and replicating are separate

Proposed guarantees for `store`:

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
  missing data. Exact duplicate/conflict rules depend on canonical record identity.

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

Initially, preserve the existing public behavior where possible: locally
available documents can be ready while background sync continues; missing
documents wait for startup and current sources to have a chance; a later peer
can make an unavailable document available again. Explicitly test initial
hydration so receipt of an arbitrary first blob does not prematurely expose a
partial initial document.

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

Prefer backend-owned reclamation based on sedimentree metadata. Do not put a
`removeBlob()` loop in Repo, or infer redundancy from absence in a partially
hydrated application document. Records not yet decoded or decrypted must remain
safe.

If Subduction cannot yet perform safe reclamation through its public API, keep
redundant records initially or add an explicit replacement/coverage operation.
Storage growth is preferable to unproven deletion. Whether metadata alone is
sufficient, and how proof of coverage is represented, is an implementation
validation item—not an assumption to bury in a save callback.

### 5. Backpressure and resource limits

Opening many documents or receiving a large history must not create unbounded
storage reads, writes, listener callbacks, or buffered blobs.

The implementation must bound work and delivery queues. It may coalesce status
observations and batch records. It must not silently drop record updates: use
producer backpressure, a replayable durable cursor, or an explicit rescan
protocol. The selected mechanism must also work for the legacy implementation.

Use metadata-first extraction and bundle only new records. Avoid serializing
every fragment on each edit, applying one handle update per received blob, or
performing full-collection work for every per-document event.

### 6. Lifecycle and ownership

Proposed initial ownership rule: a backend instance has one owner, either Repo
or a parent composite backend. Repo shutdown closes its injected backend; a
composite closes its children. Shared ownership and cyclic composition are not
implicit and would require a separate lifetime contract. Multiple sessions for
one sedimentree have independent lifetimes, even when the backend shares work
between them. Ending stream consumption must release its watch, not leave an
unread queue growing indefinitely.

An abort signal on `find` or a synchronization wait cancels that caller's wait,
not other sessions or already accepted persistence. Session close, rather than
cancelling a wait, is how the caller releases its interest.

| Operation | Meaning |
| --- | --- |
| Session close | Release local observation/interest; stop future delivery and release listeners. Do not delete data or cancel already accepted writes. |
| Repo cache eviction | Stop local document work, preserve pending edits, close its watch, then release handles/query bookkeeping. Remote replication may continue inside the backend. |
| Local deletion | Quiesce that document's local producers, invalidate existing watches, drain/order earlier work, and remove locally retained data and relevant protocol state. Not a replicated tombstone. |
| Backend close | Reject new work, quiesce producers/reconnect loops, drain accepted persistence, stop delivery, disconnect transports, and release storage/WASM resources. |

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

Do not promise both an unconditional timeout and a completed durability barrier
for a storage operation that cannot be cancelled. Define an explicit failure or
forced-close policy rather than silently dropping writes and reporting success.

## Automerge translation

This layer is responsible for:

1. Extracting commit/fragment metadata from an Automerge document.
2. Encoding only records not already represented in the backend.
3. Applying incoming blobs in batches, preserving concurrent local edits.
4. Relating backend commit heads to Automerge history and readiness.
5. Converting between document/URL identities and sedimentree identities.

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

Main's lockfile currently resolves Automerge 3.2.6; the inspected Subduction
branch pins 3.3.2 and uses `getFragmentMetadata` and `bundleFragmentMetadata`.
Validate and deliberately update the Automerge dependency needed for this
translation. Do not import private WASM internals or assume a branch file will
work against main's current dependency set.

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
without requiring an application watch. If Repo retains an application-facing
discovery event, it should be driven by an explicit backend observation, not be a
prerequisite for accepting data.

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

The backend must reject unsupported payload formats predictably. There is no
promise that a future non-Automerge CRDT or encrypted representation will work
through legacy sync. How format compatibility is declared at setup is an open
API question; silent attempts to decode arbitrary blobs are not the contract.

## Subduction backend

Implement the same contract around Subduction without moving the branch's entire
`SubductionSource` into core Repo.

Responsibilities include:

- Mapping plain records/IDs to Subduction values and releasing WASM resources.
- Coordinating initial enumeration and subsequent data notifications.
- Local persistence and safe compaction.
- Connections, subscriptions, retry scheduling, and bounded synchronization.
- Remote-head, connection, error, and ephemeral observations.

Automerge fragment extraction and handle mutation move to the translation layer.
Storage callbacks, if temporarily required, stay private to this backend. Prefer
small upstream Subduction changes over a permanent wrapper that must reverse
engineer storage writes to learn what the sync engine has done.

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

Delivery is best-effort, not persisted. Each concrete backend owns its
protocol-specific relay/loop suppression; a composite additionally deduplicates
and, when configured, relays across children. A standalone Subduction backend
must not depend on a legacy synchronizer to do this. Preserve document-scoped
broadcast behavior, including sub-handle fanout, without promising reliable
delivery.

Connection/session identity, a durable legacy storage ID, and a Subduction
verifying-key identity are different concepts. The observation types should
preserve those distinctions rather than cast all three to `StorageId`.
Remote-head observations are claims about known history, not proof of durable
remote backup. Persisting/replaying observations and legacy gossip belong to the
backend; Repo needs only the generic view required by its document API.

Public API migration should be explicit:

| Current API | Proposed destination |
| --- | --- |
| `storage`, `network`, `isEphemeral`, legacy sharing/gossip/tuning options | Legacy backend construction/configuration. |
| Subduction signer, endpoint, timeout, policy options | Subduction backend construction/configuration. |
| `networkSubsystem`, `storageSubsystem`, `synchronizer`, peer metadata table | Remove from core Repo; expose backend-specific diagnostics only where needed. |
| `storageId()`, `getStorageIdOfPeer()`, `subscribeToRemotes()` | Legacy backend APIs or explicit compatibility facade. |
| `shareConfigChanged()` | Backend-specific policy invalidation; not a generic signal for retrying decryption. |
| `peers`, `peerId`, remote-head APIs | Define generic identity/observation semantics, then provide compatibility mappings where meaningful. |
| `flush`, deletion, cache eviction, shutdown | Remain Repo operations, implemented through translation barriers and backend lifecycle. |
| Document progress, metrics, discovery events | Preserve useful behavior; stop exposing legacy source names/protocol state as the generic model. |

Do not make `new Repo()` silently construct legacy machinery. Decide whether an
explicit backend is required or a small in-memory sedimentree backend provides
the local-only default. Neither choice should implicitly initialize Subduction
WASM or import Node adapters.

## Implementation plan

### 1. Validate the contract with a narrow vertical slice

- Settle record identity, ID mapping, payload compatibility, and the
  load/watch/checkpoint protocol enough to implement them.
- Verify the required Automerge APIs and dependency update independently.
- Build a minimal deterministic in-memory backend/test double and translation.
- Implement legacy translation for create, edit, persist, reload, and two-peer
  sync; check interoperability with an unmodified legacy Repo.
- Exercise the same operations with a thin experimental Subduction wrapper.
- Compose the two using only public interfaces. Validate edits in both directions
  between legacy-only and Subduction-only peers, an unopened document requested
  on one side but stored on the other, and one failing child store.

This phase is a design test, not a wholesale extraction. It should expose an
impossible contract, duplicate-materialization costs, or missing upstream
Subduction facilities before moving all the legacy code.

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
- Replace storage-event coupling upstream where practical; keep any temporary
  adaptation encapsulated.
- Validate fragments, compaction, late-arriving data, retry behavior, and shutdown
  under real Subduction transport/storage implementations.

### 4. Implement and validate the composition package

- Combine backend instances without importing their private APIs or core Repo.
- Implement inventory/demand coordination, cross-propagation, and child-scoped
  observations, preserving the per-child checkpoints and errors.
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
- Keep non-Automerge public document APIs and E2EE follow-up work separate.

## Test strategy and acceptance criteria

### Shared contract tests

Run against every backend for its supported payload format:

- Gap-free initial load plus watch, including writes before/while opening and
  concurrent fragment replacement.
- Batched and duplicate delivery; local self-echoes; out-of-order dependencies.
- Failed/partially persisted stores followed by idempotent retries.
- Local durability independent of network availability.
- Flush barriers under concurrent edits, bounded work, and aggregated failures.
- Session close, cache eviction/reopen, local deletion with late callbacks, and
  backend shutdown with in-flight work.
- No peers versus startup pending versus negative response versus failed sync;
  later peer arrival and retry.
- Slow consumers and large histories without silent update loss or unbounded
  queues.
- Remote-head checkpoint ordering and ephemeral sender/loop semantics.
- Lossless ID conversion and predictable rejection of unsupported formats.

### Composition tests

Run the composite through the shared contract suite and add mixed-topology tests:

- Legacy-only and Subduction-only peers exchange edits through a composite,
  including remote changes never echoed back by Repo.
- A remote request discovers history stored only in the other child, without an
  application handle or premature `doc-unavailable` response.
- Child inventories diverge on startup, then reconcile without losing history.
- Duplicate records and different equivalent fragment packagings stop
  circulating; multiple bridges and reconnects do not cause write storms.
- One child's data remains usable while another loads or fails; child provenance
  and synchronization checkpoints remain accurate.
- Partial store failures, retry, restart, and flush cover outstanding forwarding,
  not just operations already submitted to children.
- Ephemeral identities survive fanout and relay; identical payloads from distinct
  broadcasts are not incorrectly deduplicated.
- Routing policies prevent unintended cross-network disclosure and unsupported
  payloads fail predictably.
- Cache eviction, deletion, and shutdown cannot leave forwarding loops, drop
  acknowledged work, or resurrect an old local generation.

### Repo behavior tests

Use a deterministic backend to test translation and public behavior without
network machinery: synchronous create, clone/import/export, changes, views and
fixed-head queries, initial hydration, sub-handles, progress, broadcasts, and
no-op reloads. Ensure changes made during load/save are retained and initial
creation is persisted even if there is no later edit.

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

- Core Repo has no legacy wire messages, adapter construction, sync-state
  persistence, or concrete Subduction dependency.
- Concrete and composite backends work through the same sedimentree-level
  contract with no `DocHandle`, `DocumentQuery`, or `Automerge.Doc` in it.
- Legacy-backed Repo reads existing storage and exchanges documents with an
  unmodified legacy peer.
- Subduction-backed Repo works without any legacy synchronizer, including
  ephemeral messages and remote-head observation.
- One Repo can use both protocols through an external composite backend. The
  composition package can bridge legacy-only and Subduction-only peers using
  only the common public contract, without changes to Repo.
- Lifecycle and durability guarantees are tested, not inferred from timers.
- The contract admits opaque payloads from another CRDT; the legacy backend's
  Automerge-only limitation is explicit.

## Questions to resolve before freezing the API

1. **Record identity and equivalence:** What canonically identifies fragments and
   transformed blob representations? Which equivalent repackagings may a backend
   return? Can all proposed compaction decisions be proved from metadata?
2. **IDs:** How do existing UUID URLs, longer document IDs, and native sedimentree
   IDs round-trip without collisions or truncation?
3. **Observation:** Async stream or callbacks? What provides bounded buffering,
   initial cut/checkpoints, and replay after overflow or interruption?
4. **Readiness:** Which initial remote checkpoints should Repo wait for when no
   complete local document exists? How do failures surface without falsely
   declaring absence or leaving a query pending forever?
5. **Compatibility:** How does a backend declare accepted payload formats and
   identity/observation capabilities without inventing CRDT type negotiation for
   the legacy wire protocol?
6. **Discovery and identity APIs:** Which existing Repo events/getters remain
   generic, and which move to backend-specific APIs? Should discovery ever
   automatically materialize an application handle?
7. **Lifecycle:** What is the policy for an uncancellable storage operation during
   close? Is persistent deletion separately awaitable through Repo's public API?
8. **Upstream work:** Which Subduction APIs are missing for coordinated data
   observation and safe reclamation, and which should be added upstream instead
   of emulated indefinitely?
9. **Default and packaging:** Require an explicit backend or provide local-only
   memory behavior? What package names and temporary compatibility exports are
   appropriate for release?
10. **Composition:** How do inventory observation and bounded inbound-demand
    resolution cooperate without recursion or premature unavailability? What
    coverage and ephemeral identity information is needed to prevent loops?
    Which routing/write policies and partial-failure recovery guarantees should
    the first composition package support?

These questions should be answered with the vertical slice and conformance tests,
not by copying the current Subduction API or preserving all of main's incidental
internal interfaces.
