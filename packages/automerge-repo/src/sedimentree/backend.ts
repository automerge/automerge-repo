import {
  mintDocumentId,
  sedimentreeId,
  type CommitId,
  type SedimentreeId,
} from "./ids.js"
import type { RecordBatch } from "./records.js"
import type {
  AnyExtensionEvent,
  AnyHandleExtension,
  HandleExtensionSpec,
} from "./extension.js"

/**
 * An interface for storing and syncing sedimentrees. `X` is what its handle
 * extensions add
 */
export interface SedimentreeBackend<X extends HandleExtensionSpec = {}> {
  create(
    initialRecords: RecordBatch,
    options?: { documentId?: SedimentreeId }
  ): Promise<SedimentreeId>

  open(id: SedimentreeId): SedimentreeSession

  store(id: SedimentreeId, batch: RecordBatch): Promise<void>

  flush(ids?: readonly SedimentreeId[]): Promise<void>

  deleteLocal(id: SedimentreeId): Promise<void>

  close(): Promise<void>

  readonly handleExtensions?: HandleExtensions<X>
}

/**
 * The extensions a backend lists, adding `X` to its handles; made with
 * {@link provides}.
 */
export type HandleExtensions<X extends HandleExtensionSpec> =
  readonly AnyHandleExtension[] & {
    /** Type only: never set. */
    readonly "~spec"?: X
  }

export interface SedimentreeSession {
  readonly events: AsyncIterable<SedimentreeEvent | AnyExtensionEvent>

  /**
   * The consumer has verified its initial load; the backend may stop work done
   * only for readiness. Likely to change
   *
   * @experimental
   */
  markReady(): void

  close(): Promise<void>
}

export type BackendOperation =
  | "create"
  | "open"
  | "store"
  | "flush"
  | "delete"
  | "synchronize"
  | "extension"
  | "close"

export class BackendError extends Error {
  constructor(
    readonly operation: BackendOperation,
    readonly code:
      | "closed"
      | "deleted"
      | "invalid-id"
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

export function backendId(
  operation: BackendOperation,
  value: string | Uint8Array
): SedimentreeId {
  try {
    return sedimentreeId(value)
  } catch (cause) {
    throw new BackendError(
      operation,
      "invalid-id",
      cause instanceof Error ? cause.message : String(cause),
      false,
      { cause }
    )
  }
}

export type MintDocumentId = (
  initialRecords: RecordBatch
) => Uint8Array | Promise<Uint8Array>

export async function mintBackendId(
  initialRecords: RecordBatch,
  mint?: MintDocumentId
): Promise<SedimentreeId> {
  if (!mint) return mintDocumentId()
  let minted: Uint8Array
  try {
    minted = await mint(initialRecords)
  } catch (cause) {
    throw new BackendError(
      "create",
      "invalid-id",
      "Minting a document ID failed",
      false,
      { cause }
    )
  }
  return backendId("create", minted)
}

/** Identifies a peer or Repo. */
export interface BackendIdentity {
  readonly kind: string
  readonly id: string
  readonly path: readonly string[]
}

/** Heads to verify, at a process-local stream position. */
export interface HistoryMarker {
  readonly sequence: number
  readonly heads: readonly CommitId[]
}

export interface SyncRoundResult {
  readonly roundId: string
  readonly marker: HistoryMarker
  /** `failed` if any peer failed. */
  readonly outcome: "complete" | "no-peers" | "failed"
  readonly peers: readonly {
    peer: BackendIdentity
    /** `unavailable`: peer has no history for this ID. */
    outcome: "complete" | "unavailable" | "failed"
    error?: BackendError
  }[]
}

/** A session event. A backend with handle extensions unions its own
 * `extension` event types with this; see {@link AnyExtensionEvent}. */
export type SedimentreeEvent =
  /** `initial` records form the local load; `live` records follow. */
  | {
      readonly type: "records"
      readonly sequence: number
      readonly phase: "initial" | "live"
      readonly records: RecordBatch
    }
  /**
   * End of the local load. If it was empty, the backend runs a sync round
   * itself and reports it as `synchronized`.
   */
  | {
      readonly type: "local-load-complete"
      readonly marker: HistoryMarker
      readonly found: boolean
    }
  | { readonly type: "history-marker"; readonly marker: HistoryMarker }
  /** Its marker is a target: named records may arrive afterwards. */
  | { readonly type: "synchronized"; readonly result: SyncRoundResult }
  | {
      readonly type: "remote-heads"
      readonly sequence: number
      readonly remote: BackendIdentity
      readonly heads: readonly CommitId[]
    }
  /** A nonretryable failure ends the stream. */
  | {
      readonly type: "failure"
      readonly sequence: number
      readonly error: BackendError
    }
  /** Ends the stream. */
  | { readonly type: "deleted"; readonly sequence: number }
