import {
  decodeHeads,
  encodeHeads,
  stringifyAutomergeUrl,
} from "./AutomergeUrl.js"
import type { DocumentState } from "./DocumentState.js"
import { mergeStates, requireView } from "./DocType.js"
import type {
  DocumentId,
  AutomergeUrl,
  PeerId,
  SyncInfo,
  UrlHeads,
} from "./types.js"

/** A handle of any view, change and event types. */
export type AnyHandle = Handle<any, any, any>

/** The events every handle emits. `V` is what `doc()` returns. */
export interface CoreHandleEvents<V = unknown, H = AnyHandle> {
  /** The heads moved. `doc` is the whole document's value. */
  "heads-changed": (payload: { handle: H; doc: V }) => void
  change: (payload: { handle: H; doc: V | undefined }) => void
  delete: (payload: { handle: H }) => void
  /**
   * A peer reported its heads. Reports received before the handle is ready
   * are delivered once, per peer with its latest heads, shortly after it
   * becomes ready; none are delivered if it never does.
   */
  "remote-heads": (payload: {
    peerId: PeerId
    heads: UrlHeads
    timestamp: number
  }) => void
}

/**
 * The listener for an event whose listeners are typed `F`, on handle `This`:
 * a payload `handle` is `This`, the handle listened on, with whatever members
 * its type adds (a backend's, say).
 */
export type ListenerOn<F, This> = F extends (payload: infer P) => infer R
  ? P extends { handle: unknown }
    ? (payload: PayloadOn<F, This>) => R
    : F
  : F

/** The payload of an event whose listeners are typed `F`, on handle `This`:
 * its `handle` is `This`. */
export type PayloadOn<F, This> = F extends (payload: infer P) => any
  ? P extends { handle: unknown }
    ? { [Q in keyof P]: Q extends "handle" ? This : P[Q] }
    : P
  : never

/** Event subscription methods for an event map `E`. */
export interface HandleEventApi<E extends object> {
  on<K extends keyof E>(event: K, fn: ListenerOn<E[K], this>): this
  addListener<K extends keyof E>(event: K, fn: ListenerOn<E[K], this>): this
  once<K extends keyof E>(event: K, fn: ListenerOn<E[K], this>): this
  off<K extends keyof E>(event: K): this
  off<K extends keyof E>(event: K, fn: ListenerOn<E[K], this> | undefined): this
  removeListener<K extends keyof E>(event: K): this
  removeListener<K extends keyof E>(
    event: K,
    fn: ListenerOn<E[K], this> | undefined
  ): this
  removeAllListeners<K extends keyof E>(event?: K): this
  listenerCount<K extends keyof E>(event: K): number
  listeners<K extends keyof E>(event: K): ListenerOn<E[K], this>[]
  emit<K extends keyof E>(event: K, payload: PayloadOn<E[K], this>): boolean
}

/** @internal Construction options; only Repo and other handles build handles. */
export type HandleOptions = {
  heads?: UrlHeads
}

let stateOf: (handle: AnyHandle) => DocumentState
let fixedHeadsOf: (handle: AnyHandle) => UrlHeads | undefined

/** @internal The document state behind a handle. */
export const handleState = (handle: AnyHandle) => stateOf(handle)
/** @internal A handle's fixed heads, if it is a view. */
export const handleHeads = (handle: AnyHandle) => fixedHeadsOf(handle)

/**
 * The parts of a handle every document type has: identity, reading at the
 * current or fixed heads, the type's `change`, views, merging, deletion, and
 * events. Document types may subclass it to add their own API.
 *
 * `V` is what `doc()` returns, `C` what `change()` takes, and `E` the
 * handle's own events. Backend extension members and events are added by the
 * Repo; see {@link DocHandle}.
 */
export class Handle<
  V = unknown,
  C = unknown,
  E extends object = CoreHandleEvents<V>,
> implements HandleEventApi<E> {
  static {
    stateOf = handle => handle.#state
    fixedHeadsOf = handle => handle.#heads
  }

  /** Type only: the name of this handle's doc type, which its URL is typed
   * with; `DocHandle` sets it. */
  declare readonly "~name": string

  /**
   * Type only, never set: the backend's extension spec; `DocHandle` sets
   * its type. A method returning another handle reads it with
   * `BackendOf<this>`, to give that handle the same extensions.
   */
  declare readonly "~spec"?: {}

  /** Shared per-document state. Every handle into the same doc shares one. */
  readonly #state: DocumentState
  /** If set, this handle shows the document only at these heads. */
  readonly #heads?: UrlHeads

  /** @internal Handles are obtained from a {@link Repo} or another handle. */
  constructor(state: DocumentState, options: HandleOptions = {}) {
    this.#state = state
    this.#heads = options.heads
  }

  get documentId(): DocumentId {
    return this.#state.documentId
  }

  /** `automerge:<doc type name>:<documentId>[#heads]` */
  get url(): AutomergeUrl<this["~name"]> {
    return stringifyAutomergeUrl({
      docType: this.#state.docType,
      documentId: this.documentId,
      heads: this.#heads,
    }) as AutomergeUrl<this["~name"]>
  }

  /**
   * @returns true once the first snapshot is ready, unless deleted.
   */
  isReady = () => this.#state.ready && !this.#state.deleted

  /**
   * @returns true if the document has been marked as deleted.
   */
  isDeleted = () => this.#state.deleted

  /** The document's value at this handle's heads. */
  doc(): V {
    return this.#state.docType.value(this.#state.viewAt(this.#heads)) as V
  }

  /**
   * Returns the "heads" of the document, akin to a git commit.
   * This precisely defines the state of a document.
   * @returns the current document's heads (which may be fixed by .view() or equivalent)
   */
  heads(): UrlHeads {
    if (this.#heads) return this.#heads
    return encodeHeads(this.#state.heads())
  }

  /**
   * True if every hash in `heads` is in this document's history. For a
   * view, only history up to its fixed heads counts.
   */
  hasHeads(heads: UrlHeads): boolean {
    return this.#state.docType.hasHeads(
      this.#state.viewAt(this.#heads),
      decodeHeads(heads)
    )
  }

  /** A read-only handle to the document as of `heads`. */
  view(heads: UrlHeads): this {
    const state = this.#state
    requireView(state.docType)
    const key = [...heads].sort().join(",")
    return state.handles.getOrCompute(
      key,
      () => new state.Handle(state, { heads })
    ) as this
  }

  /** Returns the heads and the timestamp of the last update from the given peer. */
  getSyncInfo(peerId: PeerId): SyncInfo | undefined {
    return this.#state.getSyncInfo(peerId)
  }

  /**
   * Change the document with the type's `change`. Mutation and events are
   * immediate. The returned promise resolves once this change and every
   * earlier local change are recoverable; it does not wait for peers.
   */
  change(change: C): Promise<void> {
    this.#throwIfFixedHeads("change")
    const state = this.#state
    return state.applyMutation(doc =>
      state.docType.change(doc, change, state.context)
    )
  }

  /**
   * Check if the document can be change()ed. Documents can be edited
   * unless viewed at a particular point in time.
   */
  isReadOnly(): boolean {
    return !!this.#heads
  }

  /**
   * Bring another document's history into this one; both must be of the same
   * type. Peers receive the result like any change.
   */
  merge(other: AnyHandle): Promise<void> {
    this.#throwIfFixedHeads("merge")
    const { docType } = this.#state
    const otherState = other.#state
    if (otherState.docType.name !== docType.name)
      throw new Error(
        `Cannot merge a ${otherState.docType.name} document into a ${docType.name} document`
      )
    const incoming = otherState.viewAt(other.#heads)
    // A merge can bring many boundaries at once; store their fragments with it.
    return this.#state.applyMutation(
      doc => mergeStates(docType, doc, incoming),
      {
        compact: true,
      }
    )
  }

  /**
   * Marks the document deleted and fans `delete` out to every retained
   * handle. Prefer {@link Repo.delete} from user code.
   */
  delete() {
    this.#state.delete()
  }

  /** True if the other handle has the same URL as this one. */
  equals(other: AnyHandle): boolean {
    return this.url === other.url
  }

  #throwIfFixedHeads(operation: string) {
    if (this.#heads) {
      throw new Error(
        `Cannot ${operation} on DocHandle#${this.documentId}: it is in view-only mode at specific heads.`
      )
    }
  }

  // Event subscription. Listeners live in the document's Listeners, keyed by
  // handle, which holds handles strongly, so any handle with a listener is
  // naturally retained.

  on<K extends keyof E>(event: K, fn: ListenerOn<E[K], this>): this {
    this.#state.listeners.add(this, event as string, fn as any)
    return this
  }

  addListener<K extends keyof E>(event: K, fn: ListenerOn<E[K], this>): this {
    return this.on(event, fn)
  }

  once<K extends keyof E>(event: K, fn: ListenerOn<E[K], this>): this {
    this.#state.listeners.add(this, event as string, fn as any, true)
    return this
  }

  /**
   * @deprecated Handles are shared across the app, so this also removes
   * listeners other code added. Pass the listener to remove: `off(event, fn)`.
   */
  off<K extends keyof E>(event: K): this
  off<K extends keyof E>(event: K, fn: ListenerOn<E[K], this> | undefined): this
  off<K extends keyof E>(event: K, fn?: ListenerOn<E[K], this>): this {
    this.#state.listeners.remove(this, event as string, fn as any)
    return this
  }

  /**
   * @deprecated Handles are shared across the app, so this also removes
   * listeners other code added. Pass the listener to remove:
   * `removeListener(event, fn)`.
   */
  removeListener<K extends keyof E>(event: K): this
  removeListener<K extends keyof E>(
    event: K,
    fn: ListenerOn<E[K], this> | undefined
  ): this
  removeListener<K extends keyof E>(
    event: K,
    fn?: ListenerOn<E[K], this>
  ): this {
    return this.off(event, fn)
  }

  /**
   * @deprecated Handles are shared across the app, so this also removes
   * listeners other code added (bindings, `Presence`). Remove your own
   * listeners with `off(event, fn)`.
   */
  removeAllListeners<K extends keyof E>(event?: K): this {
    const listeners = this.#state.listeners
    if (event === undefined) listeners.removeAll(this)
    else listeners.remove(this, event as string)
    return this
  }

  /** Number of listeners attached for the given event. */
  listenerCount<K extends keyof E>(event: K): number {
    return this.#state.listeners.count(this, event as string)
  }

  /** Snapshot of currently-registered listener functions for the given event. */
  listeners<K extends keyof E>(event: K): ListenerOn<E[K], this>[] {
    return this.#state.listeners.listeners(this, event as string) as ListenerOn<
      E[K],
      this
    >[]
  }

  /**
   * Names of events with at least one listener attached. Typed as this
   * handle's event names, though open to any string: a handle with more
   * events must still be usable where one with fewer is expected.
   */
  eventNames(): (keyof E | (string & {}))[] {
    return this.#state.listeners.eventNames(this)
  }

  /**
   * Emit an event on this handle. Fires *only* this handle's listeners; use
   * `delete()` to fan out the document-level lifecycle events.
   *
   * @deprecated Events come from the document; emitting one by hand shows
   * every listener on this shared handle an event that didn't happen.
   */
  emit<K extends keyof E>(event: K, payload: PayloadOn<E[K], this>): boolean {
    return this.#state.listeners.emit(this, event as string, payload)
  }
}
