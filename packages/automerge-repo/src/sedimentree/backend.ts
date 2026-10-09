import type { CommitId, SedimentreeId } from "./ids.js"
import type { RecordBatch } from "./records.js"

/**
 * Experimental, single-owner backend for storing and observing sedimentree
 * history. This boundary contains plain IDs, metadata and bytes: no document
 * handles, CRDT documents, transports or WASM objects. The owner is responsible
 * for closing the backend.
 *
 * ## Observation and readiness
 *
 * `open()` establishes a finite initial local cut and live observation together,
 * before the first pull. Initial record batches reconstruct that cut; later
 * updates follow without a gap. Concurrent writes must not indefinitely extend
 * initial loading. Opening expresses interest, not a network connection, and
 * does not by itself create stored history or a public document handle.
 *
 * Each stream is single-consumer, with at most one outstanding `next()`. Batches
 * and live replay are bounded. Overlap, duplicate records and self-echoes are
 * permitted; consumers must merge history idempotently rather than treating
 * each delivery as a new local edit. A slow consumer gets an explicit rescan
 * requirement instead of silent history loss or an unbounded queue.
 *
 * Session events report backend facts, not CRDT document readiness:
 *
 * - `records`: history to merge. `phase: "initial"` belongs to the pinned cut;
 *   `phase: "live"` follows it. Delivery is not a local-durability receipt:
 *   events may race a store promise or expose remote data before it is persisted.
 * - `local-load-complete`: local enumeration reached its marker. `found`
 *   says whether that cut contained records, not whether their dependencies are
 *   materialized or any peer has data. When `found` is false, marker heads
 *   are empty. Empty local storage is not global absence. Sync events follow
 *   this initial completion event, not precede it.
 * - `history-marker`: a position and history heads, ordered after associated record
 *   deliveries. The consumer must process those records and verify history
 *   inclusion using its CRDT; nonempty heads or the first blob are not enough.
 * - `synchronized`: the result of a bounded synchronization round, ordered after
 *   its associated data. Resolving the matching `synchronize()` promise does not
 *   mean the stream has been consumed. Neither `complete` nor `no-peers` proves
 *   global convergence or remote durability; per-peer outcomes retain identity.
 * - `remote-heads`: a peer's advertised history, not proof that we have it or
 *   that the peer has durably stored our writes.
 * - `ephemeral`: best-effort, nonpersistent application data. The envelope's
 *   claimed origin is distinct from `sender`, the authenticated signed originator
 *   (not necessarily the immediate relay/transport peer). Consumers use `sender`
 *   for application sender identity; claimed origin is untrusted loop metadata.
 * - `failure`: an operation-scoped error, not an empty lookup. Retryable failures
 *   leave the watch usable; nonretryable failures may end it. Neither proves
 *   global absence. Explicit operations can also reject their promises.
 * - `rescan-required`: the replay window no longer covers this consumer. It is
 *   the final event on that stream. Reopen for a fresh cut and merge into the
 *   existing state, preserving local edits. Stored history remains recoverable;
 *   transient ephemerals are not recovered by a rescan.
 * - `deleted`: invalidates the old local generation and ends its stream,
 *   superseding queued old-generation data. This is not a replicated tombstone.
 *
 * Readiness requires a complete initial snapshot from any one usable source,
 * verified by the CRDT consumer against the delivered marker. Other sources
 * may continue loading. A lookup failure or timeout is never proof of absence.
 * Sequence positions are process-local, scoped to their log and lifetime, not
 * portable cursors or comparable across backends/documents/generations. Initial
 * batches can share the cut's sequence; it is not a unique ID for each batch.
 *
 * ## Ownership and lifetime
 *
 * Calls must snapshot mutable inputs they retain before returning control to
 * the caller, without waiting for the returned promise. In particular, a caller
 * can reuse input byte buffers or metadata arrays immediately after `store()`.
 * Returned metadata is readonly; implementations may freeze/share immutable
 * metadata. Delivered byte buffers are separately owned by each consumer and
 * must not alias retained storage or another consumer's writable buffers.
 *
 * Session lifetimes are independent, even if the backend shares underlying work.
 * Breaking iteration, iterator `return()`, or session close releases that watch
 * and wakes a pending pull. None deletes history or cancels accepted persistence.
 * Cancellation of a synchronization wait affects only that caller; release the
 * session explicitly to end interest. Backend close ends all its watches.
 *
 * This is a provisional scaffold, not the final network/composition contract.
 * Inbound-demand resolution, generic coverage operations and composite child
 * observations still need the real-backend validation in
 * `SUBDUCTION_INTEGRATION.md`, phase 1b.
 */
export interface SedimentreeBackend {
  /**
   * Use the requested ID or mint one, then store initial history locally.
   * An ID that already holds records rejects with a create/conflict error;
   * an empty ID is available. Supplied IDs are a backend-only option, not Repo.create.
   */
  create(
    initialRecords: RecordBatch,
    options?: { documentId?: SedimentreeId }
  ): Promise<SedimentreeId>

  /**
   * Observe IDs without opening sessions or materializing public handles. Pins a
   * finite initial collection cut at the call, then follows live activity.
   * `document` events identify initial entries or subsequent activity, so IDs
   * may repeat. Merely opening an empty ID does not add it to the collection.
   * `local-load-complete` ends initial enumeration, not the stream; `deleted`
   * removes an ID locally but also does not end the collection stream. `failure`
   * and terminal `rescan-required` follow the same rules as document observation.
   * On rescan call this method again, reconciling the fresh inventory.
   */
  observeCollection(): AsyncIterable<CollectionObservation>

  /**
   * Establish initial loading and live observation of one ID without a race,
   * and register interest for automatic synchronization under backend policy.
   * An empty local load leaves the session open for future data. No explicit
   * synchronization call is required after each local store.
   */
  open(id: SedimentreeId): SedimentreeSession

  /**
   * Resolve when ALL submitted history is recoverable under the backend's
   * documented local durability guarantee, not when a peer receives it or an
   * observer consumes it. Schedule propagation according to backend policy even
   * when there is no open session for the ID.
   *
   * A batch is NOT a transaction: rejection may leave some records persisted
   * and observed. No rollback is required. Retrying the whole equivalent batch
   * must be safe. Acknowledging a replacement must not lose both old and new data.
   * Invalid/unsupported records reject rather than silently becoming missing data.
   *
   * Logical record identity does not establish representation equality or history
   * equivalence. Variant handling is backend-specific; the memory double's exact
   * conflict rejection is not required of other backends. Coverage-based removal
   * or deduplication requires separate evidence, not just a matching logical key.
   */
  store(id: SedimentreeId, batch: RecordBatch): Promise<void>

  /**
   * Capture and drain accepted local persistence for these IDs (all if omitted).
   * Work accepted before the call is included; later work need not hold this
   * barrier open. Drain all targeted work before reporting errors. Do not wait
   * for network delivery or stream consumers. Work buffered by the caller but
   * not yet submitted is outside this barrier and must be submitted first.
   */
  flush(ids?: readonly SedimentreeId[]): Promise<void>

  /**
   * Invalidate this ID's sessions, order/drain earlier work, and remove local
   * history and protocol state. Fence callbacks from the old generation so they
   * cannot resurrect it, and reject stores while the deletion barrier is active.
   * Resolve only after removal, or reject on failure. The caller must also stop
   * its own producers. A later explicit open/store or remote request can reacquire
   * the ID; permanent refusal requires separate policy, not a local tombstone.
   */
  deleteLocal(id: SedimentreeId): Promise<void>

  /**
   * Idempotently reject new work, quiesce producers, drain accepted persistence,
   * end watches and release resources. Attempt all cleanup before reporting
   * failures. There is no unconditional timeout: an uncancellable hanging write
   * can keep close pending. Session close is not a substitute for this barrier.
   */
  close(): Promise<void>
}

/** Independent interest in one sedimentree; not a transport connection. */
export interface SedimentreeSession {
  /** Initial cut and subsequent observations, as described by SedimentreeBackend. */
  readonly events: AsyncIterable<SedimentreeEvent>

  /**
   * Request a bounded round under backend policy, e.g. for an explicit retry.
   * The result correlates with a `synchronized` event whose marker follows
   * the associated records. Completion does not imply those records were applied
   * by the consumer, all peers were contacted, or remote durability was obtained.
   * Aborting cancels only this wait, not other sessions or accepted persistence.
   */
  synchronize(options?: { signal?: AbortSignal }): Promise<SyncRoundResult>

  /**
   * Best-effort publication, with no persistence or delivery guarantee. Allocate
   * message identity once before fanout and preserve it and claimed origin while
   * forwarding; receiving backends/bridges deduplicate loops. No peers is a no-op.
   * Rescan cannot recover missed ephemeral messages.
   */
  publishEphemeral(message: EphemeralEnvelope): Promise<void>

  /**
   * Optional hint that the consumer has verified a complete initial snapshot.
   * Afterwards a backend may stop computing `history-marker` heads from storage
   * for this session and may report sync-round markers from the heads it
   * last delivered. Records, sync results and failures continue unchanged.
   */
  markComplete?(): void

  /** Release this watch/interest and wake pending pulls, idempotently; do not delete data. */
  close(): Promise<void>
}

export type BackendOperation =
  | "create"
  | "open"
  | "observe"
  | "store"
  | "flush"
  | "delete"
  | "synchronize"
  | "ephemeral"
  | "close"

export class BackendError extends Error {
  constructor(
    readonly operation: BackendOperation,
    readonly code:
      | "closed"
      | "deleted"
      | "invalid-record"
      | "conflict"
      | "unsupported"
      | "io",
    message: string,
    readonly retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "BackendError"
  }
}

/** Namespace/kind and child provenance are kept separate from record IDs. */
export interface BackendIdentity {
  readonly kind: string
  readonly id: string
  readonly path: readonly string[]
}

/** Globally unique message ID, allocated once before fanout. Forwarders preserve
 * ID and claimed origin, even when forwarding under a different signing identity.
 */
export interface EphemeralEnvelope {
  readonly messageId: string
  readonly origin: BackendIdentity
  readonly payload: Uint8Array
}

/**
 * A process-local position in one log/lifetime, not a portable/durable cursor.
 * A result's position orders delivery, not application by the stream consumer.
 */
export interface HistoryMarker {
  readonly sequence: number
  readonly heads: readonly CommitId[]
}

export interface SyncRoundResult {
  readonly roundId: string
  readonly marker: HistoryMarker
  readonly outcome: "complete" | "no-peers" | "failed"
  readonly peers: readonly {
    peer: BackendIdentity
    outcome: "complete" | "unavailable" | "failed"
    error?: BackendError
  }[]
}

export type SedimentreeEvent =
  | {
      readonly type: "records"
      readonly sequence: number
      readonly phase: "initial" | "live"
      readonly records: RecordBatch
    }
  | {
      readonly type: "local-load-complete"
      readonly marker: HistoryMarker
      readonly found: boolean
    }
  | { readonly type: "history-marker"; readonly marker: HistoryMarker }
  | { readonly type: "synchronized"; readonly result: SyncRoundResult }
  | {
      readonly type: "remote-heads"
      readonly sequence: number
      readonly remote: BackendIdentity
      readonly heads: readonly CommitId[]
    }
  | {
      readonly type: "ephemeral"
      readonly sequence: number
      readonly message: EphemeralEnvelope
      /** Authenticated signed originator, not the claimed origin or relay peer. */
      readonly sender: BackendIdentity
    }
  | {
      readonly type: "failure"
      readonly sequence: number
      readonly error: BackendError
    }
  | { readonly type: "rescan-required"; readonly sequence: number }
  | { readonly type: "deleted"; readonly sequence: number }

export type CollectionObservation =
  | {
      readonly type: "document"
      readonly sequence: number
      readonly phase: "initial" | "live"
      readonly id: SedimentreeId
    }
  | {
      readonly type: "deleted"
      readonly sequence: number
      readonly id: SedimentreeId
    }
  | { readonly type: "local-load-complete"; readonly sequence: number }
  | { readonly type: "rescan-required"; readonly sequence: number }
  | {
      readonly type: "failure"
      readonly sequence: number
      readonly error: BackendError
    }
