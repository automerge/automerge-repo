import { next as A } from "@automerge/automerge/slim"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import { assertEvent, assign, createActor, setup, waitFor } from "xstate"
import { encodeHeads, decodeHeads } from "./AutomergeUrl.js"
import { encode } from "./helpers/cbor.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { withTimeout } from "./helpers/withTimeout.js"
import type { DocumentId, PeerId, UrlHeads } from "./types.js"
import type { StorageId } from "./storage/types.js"
import type { DocHandle } from "./DocHandle.js"
import {
  AbortError,
  AbortOptions,
  isAbortErrorLike,
} from "./helpers/abortable.js"
import { SubHandleRegistry } from "./refs/sub-handle-registry.js"

/**
 * Owns everything that belongs to a document itself: the XState lifecycle
 * machine, the underlying Automerge document, change detection, remote
 * sync bookkeeping, and the sub-handle registry. Every `DocHandle` into
 * the document (root or scoped) holds a reference to the same
 * `DocumentState` and delegates lifecycle, doc-reads, and mutations
 * through it.
 *
 * `DocHandle` represents a specific view (path, range, optional fixed
 * heads); `DocumentState` represents the document.
 *
 * Events emitted here are *document-level* and carry no `handle`
 * reference. Subscribers (the root `DocHandle` and the sub-handle
 * registry) translate them into handle-shaped payloads for their own
 * listeners.
 *
 * Internal; consumers only ever see `DocHandle`.
 *
 * @hidden
 */
export class DocumentState extends EventEmitter<DocumentStateEvents> {
  readonly documentId: DocumentId
  readonly timeoutDelay: number
  readonly log: debug.Debugger

  /** The XState actor running the document lifecycle. */
  #machine: ReturnType<typeof createActor<any>>

  /**
   * Last observed doc snapshot. Used by the change detector that compares
   * heads before/after each state transition to decide whether to emit
   * `change` / `heads-changed`. Per-document, not per-handle.
   */
  #prevDocState: A.Doc<any>

  /** Remote sync bookkeeping, keyed by storageId. */
  #syncInfoByStorageId: Record<StorageId, SyncInfo> = {}

  /**
   * WeakRef cache of every distinct handle into this document - sub-handles
   * at a path, view-handles at fixed heads, and combinations of the two -
   * keyed by `(path, heads)` (see {@link DocHandle.handleCacheKey}). The
   * root handle is the only exception; it's owned by the `Repo` and
   * doesn't live here. Dead WeakRefs are pruned lazily during iteration.
   */
  readonly handleCache: Map<string, WeakRef<DocHandle<any>>> = new Map()

  /**
   * Strong retainers for sub-handles that currently have at least one
   * listener attached. Populated via the registry's `insert` / `remove`
   * hooks from `DocHandle`'s listener overrides.
   */
  readonly subHandleRetainers: Set<DocHandle<any>> = new Set()

  /** Sub-handle dispatcher and retention tracker. */
  readonly registry: SubHandleRegistry

  constructor(documentId: DocumentId, options: DocumentStateOptions = {}) {
    super()
    this.documentId = documentId
    this.timeoutDelay = options.timeoutDelay ?? 60_000
    this.log = debug(`automerge-repo:docstate:${documentId.slice(0, 5)}`)

    const doc = A.init<any>()
    this.#prevDocState = doc

    const delay = this.timeoutDelay

    // Lifecycle: idle -> loading -> {ready, unavailable} -> {unloaded,
    // deleted}. Actions reach back to `this` via the closure to emit
    // document-level events (e.g. `onDelete` -> `this.emit("delete")`).
    const machine = setup({
      types: {
        context: {} as DocumentContext,
        events: {} as DocumentMachineEvent,
      },
      actions: {
        /** Update the doc using the given callback. */
        onUpdate: assign(({ context, event }) => {
          const oldDoc = context.doc
          assertEvent(event, UPDATE)
          const { callback } = event.payload
          const doc = callback(oldDoc)
          return { doc }
        }),
        onDelete: assign(() => {
          this.emit("delete")
          return { doc: A.init() }
        }),
        onUnavailable: assign(() => ({ doc: A.init() })),
        onUnload: assign(() => ({ doc: A.init() })),
      },
    }).createMachine({
      initial: "idle",
      context: { documentId, doc },
      on: {
        UPDATE: { actions: "onUpdate" },
        UNLOAD: ".unloaded",
        DELETE: ".deleted",
      },
      states: {
        idle: { on: { BEGIN: "loading" } },
        loading: {
          on: { REQUEST: "requesting", DOC_READY: "ready" },
          after: { [delay]: "unavailable" },
        },
        requesting: {
          on: { DOC_UNAVAILABLE: "unavailable", DOC_READY: "ready" },
          after: { [delay]: "unavailable" },
        },
        unavailable: {
          entry: "onUnavailable",
          on: { DOC_READY: "ready" },
        },
        ready: {},
        unloaded: { entry: "onUnload", on: { RELOAD: "loading" } },
        deleted: { entry: "onDelete", type: "final" },
      },
    })

    this.#machine = createActor(machine)

    this.#machine.subscribe(state => {
      const before = this.#prevDocState
      const after = state.context.doc as A.Doc<any>
      this.log(`→ ${state.value} %o`, after)
      this.#checkForChanges(before, after)
    })

    this.#machine.start()

    // Eagerly instantiate the registry so `DocHandle` retention hooks can
    // call `insert` / `remove` on the first listener, without a lazy dance.
    // The registry subscribes to our events in its own constructor.
    this.registry = new SubHandleRegistry(this)
  }

  // ---------------- Lifecycle state queries ----------------

  state(): HandleState {
    return this.#machine.getSnapshot().value as HandleState
  }

  inState(states: HandleState[]): boolean {
    const snapshot = this.#machine.getSnapshot()
    return states.some(s => snapshot.matches(s))
  }

  isReady(): boolean {
    return this.inState(["ready"])
  }

  isUnloaded(): boolean {
    return this.inState(["unloaded"])
  }

  isDeleted(): boolean {
    return this.inState(["deleted"])
  }

  isUnavailable(): boolean {
    return this.inState(["unavailable"])
  }

  async whenInState(
    awaitStates: HandleState[],
    options?: AbortOptions
  ): Promise<void> {
    try {
      await withTimeout(
        this.#statePromise(awaitStates, options),
        this.timeoutDelay
      )
    } catch (error) {
      if (isAbortErrorLike(error)) {
        throw new AbortError("state wait aborted")
      }
      throw error
    }
  }

  #statePromise(awaitStates: HandleState[], options?: AbortOptions) {
    return waitFor(
      this.#machine,
      s => awaitStates.some(state => s.matches(state)),
      { timeout: this.timeoutDelay * 2, ...options }
    )
  }

  // ---------------- Lifecycle transitions ----------------

  begin(): void {
    this.#machine.send({ type: BEGIN })
  }

  doneLoading(): void {
    this.#machine.send({ type: DOC_READY })
  }

  unavailable(): void {
    this.#machine.send({ type: DOC_UNAVAILABLE })
  }

  request(): void {
    if (this.state() === "loading") this.#machine.send({ type: REQUEST })
  }

  unload(): void {
    this.#machine.send({ type: UNLOAD })
  }

  reload(): void {
    this.#machine.send({ type: RELOAD })
  }

  delete(): void {
    this.#machine.send({ type: DELETE })
  }

  // ---------------- Document access ----------------

  /** The current full Automerge document (at latest heads). */
  doc(): A.Doc<any> {
    return this.#machine.getSnapshot().context.doc as A.Doc<any>
  }

  /** The current heads of the latest document state. */
  heads(): UrlHeads {
    if (!this.isReady()) throw new Error("DocumentState is not ready")
    return encodeHeads(A.getHeads(this.doc()))
  }

  // ---------------- Mutation ----------------

  /**
   * Replace the document wholesale (e.g. when loading from storage). Used
   * by `Repo` during bootstrap; prefer `change` / `changeAt` for typical
   * mutations.
   */
  update(callback: (doc: A.Doc<any>) => A.Doc<any>): void {
    this.#sendUpdate(callback)
  }

  /** Apply an Automerge change under a wrapped UPDATE event. */
  change<T>(
    callback: A.ChangeFn<T>,
    options: A.ChangeOptions<T> = {}
  ): void {
    this.#sendUpdate(doc => A.change(doc as A.Doc<T>, options, callback))
  }

  /**
   * Apply a concurrent change as if the document were at `heads`. Returns
   * the heads representing the new concurrent change.
   */
  changeAt<T>(
    heads: UrlHeads,
    callback: A.ChangeFn<T>,
    options: A.ChangeOptions<T> = {}
  ): UrlHeads | undefined {
    let resultHeads: UrlHeads | undefined
    this.#sendUpdate(doc => {
      const result = A.changeAt(
        doc as A.Doc<T>,
        decodeHeads(heads),
        options,
        callback
      )
      resultHeads = result.newHeads
        ? encodeHeads(result.newHeads)
        : undefined
      return result.newDoc
    })
    return resultHeads
  }

  /**
   * Send an UPDATE to the machine wrapping the caller's callback in a
   * try/catch so synchronous throws in the callback propagate out after
   * XState has processed the event.
   */
  #sendUpdate(callback: (doc: A.Doc<any>) => A.Doc<any>): void {
    let thrownException: null | Error = null
    this.#machine.send({
      type: UPDATE,
      payload: {
        callback: (doc: A.Doc<any>) => {
          try {
            return callback(doc)
          } catch (e) {
            thrownException = e as Error
            return doc
          }
        },
      },
    } as any)
    if (thrownException) throw thrownException
  }

  /**
   * Called after each state transition. If the document's heads changed,
   * emits `heads-changed` and (if the patches aren't empty) `change`. If
   * this is the first time we've seen the document, transitions the
   * machine to `ready`.
   */
  #checkForChanges(before: A.Doc<any>, after: A.Doc<any>): void {
    const beforeHeads = A.getHeads(before)
    const afterHeads = A.getHeads(after)
    const docChanged = !headsAreSame(
      encodeHeads(afterHeads),
      encodeHeads(beforeHeads)
    )
    if (docChanged) {
      this.emit("heads-changed", { doc: after })

      const patches = A.diff(after, beforeHeads, afterHeads)
      if (patches.length > 0) {
        this.emit("change", {
          doc: after,
          patches,
          patchInfo: { before, after, source: "change" },
        })
      }

      if (!this.isReady()) this.#machine.send({ type: DOC_READY })
    }
    this.#prevDocState = after
  }

  // ---------------- Sync info ----------------

  setSyncInfo(storageId: StorageId, syncInfo: SyncInfo): void {
    this.#syncInfoByStorageId[storageId] = syncInfo
    this.emit("remote-heads", {
      storageId,
      heads: syncInfo.lastHeads,
      timestamp: syncInfo.lastSyncTimestamp,
    })
  }

  getSyncInfo(storageId: StorageId): SyncInfo | undefined {
    return this.#syncInfoByStorageId[storageId]
  }

  getRemoteHeads(storageId: StorageId): UrlHeads | undefined {
    return this.#syncInfoByStorageId[storageId]?.lastHeads
  }

  // ---------------- Ephemeral messaging ----------------

  /** Send an ephemeral message out to peers (reaches `Repo` via the event). */
  broadcast(message: unknown): void {
    this.emit("ephemeral-message-outbound", {
      data: new Uint8Array(encode(message)),
    })
  }

  /**
   * Inject a received ephemeral message. Called by the network subsystem;
   * re-emitted as an `ephemeral-message` event for subscribers (DocHandles
   * and the registry).
   */
  receiveEphemeral(senderId: PeerId, message: unknown): void {
    this.emit("ephemeral-message", { senderId, message })
  }

  // ---------------- Misc document-level helpers ----------------

  metadata(change?: string): A.DecodedChange | undefined {
    if (!this.isReady()) return undefined
    if (!change) change = this.heads()[0]
    return (
      A.inspectChange(this.doc(), decodeHeads([change] as UrlHeads)[0]) ||
      undefined
    )
  }

  metrics(): { numOps: number; numChanges: number } {
    return A.stats(this.doc())
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Document-level events. These carry no `handle` reference; subscribers
 * (`DocHandle` and `SubHandleRegistry`) translate them into handle-shaped
 * payloads for their own listeners.
 */
export interface DocumentStateEvents {
  change: (payload: DocumentChangePayload) => void
  "heads-changed": (payload: DocumentHeadsChangedPayload) => void
  delete: () => void
  "ephemeral-message": (payload: DocumentEphemeralMessagePayload) => void
  "ephemeral-message-outbound": (
    payload: DocumentEphemeralMessageOutboundPayload
  ) => void
  "remote-heads": (payload: DocumentRemoteHeadsPayload) => void
}

export interface DocumentChangePayload {
  doc: A.Doc<any>
  patches: A.Patch[]
  patchInfo: A.PatchInfo<any>
}

export interface DocumentHeadsChangedPayload {
  doc: A.Doc<any>
}

export interface DocumentEphemeralMessagePayload {
  senderId: PeerId
  message: unknown
}

export interface DocumentEphemeralMessageOutboundPayload {
  data: Uint8Array
}

export interface DocumentRemoteHeadsPayload {
  storageId: StorageId
  heads: UrlHeads
  timestamp: number
}

// ---------------------------------------------------------------------------
// Options + lifecycle types (re-exported via DocHandle for backward compat)
// ---------------------------------------------------------------------------

export interface DocumentStateOptions {
  timeoutDelay?: number
}

export type SyncInfo = {
  lastHeads: UrlHeads
  lastSyncTimestamp: number
}

// ---------------------------------------------------------------------------
// Lifecycle state machine types + constants
// ---------------------------------------------------------------------------

export const HandleState = {
  IDLE: "idle",
  LOADING: "loading",
  REQUESTING: "requesting",
  READY: "ready",
  UNLOADED: "unloaded",
  DELETED: "deleted",
  UNAVAILABLE: "unavailable",
} as const
export type HandleState = (typeof HandleState)[keyof typeof HandleState]

export const {
  IDLE,
  LOADING,
  REQUESTING,
  READY,
  UNLOADED,
  DELETED,
  UNAVAILABLE,
} = HandleState

interface DocumentContext {
  documentId: DocumentId
  doc: A.Doc<any>
}

type DocumentMachineEvent =
  | { type: typeof BEGIN }
  | { type: typeof REQUEST }
  | { type: typeof DOC_READY }
  | {
      type: typeof UPDATE
      payload: { callback: (doc: A.Doc<any>) => A.Doc<any> }
    }
  | { type: typeof UNLOAD }
  | { type: typeof RELOAD }
  | { type: typeof DELETE }
  | { type: typeof DOC_UNAVAILABLE }

const BEGIN = "BEGIN"
const REQUEST = "REQUEST"
const DOC_READY = "DOC_READY"
const UPDATE = "UPDATE"
const UNLOAD = "UNLOAD"
const RELOAD = "RELOAD"
const DELETE = "DELETE"
const DOC_UNAVAILABLE = "DOC_UNAVAILABLE"
