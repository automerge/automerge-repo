import {
  decodeHeads,
  encodeHeads,
  stringifyDocumentUrl,
} from "./AutomergeUrl.js"
import type { DocumentState } from "./DocumentState.js"
import { mergeStates } from "./DocType.js"
import type { HandleExtensionSpec } from "./sedimentree/extension.js"
import type {
  DocumentId,
  DocumentUrl,
  PeerId,
  SyncInfo,
  UrlHeads,
} from "./types.js"

/** The events every handle emits. `V` is what `doc()` returns. */
export interface CoreHandleEvents<V = unknown, H = Handle<any, any, any>> {
  "heads-changed": (payload: { handle: H; doc: unknown }) => void
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

/** @internal Construction options; only Repo and other handles build handles. */
export type HandleOptions = {
  heads?: UrlHeads
  /** Where in the document this handle points; the doc type interprets it. */
  scope?: unknown
}

let stateOf: (handle: Handle<any, any, any>) => DocumentState<any>
let scopeOf: (handle: Handle<any, any, any>) => unknown
let fixedHeadsOf: (handle: Handle<any, any, any>) => UrlHeads | undefined

/** @internal The document state behind a handle. */
export const handleState = (handle: Handle<any, any, any>) => stateOf(handle)
/** @internal A handle's scope; `undefined` for the whole document. */
export const handleScope = (handle: Handle<any, any, any>) => scopeOf(handle)
/** @internal A handle's fixed heads, if it is a view. */
export const handleHeads = (handle: Handle<any, any, any>) =>
  fixedHeadsOf(handle)

/**
 * @internal The handle for `scope` at `heads` on `handle`'s document: the
 * cached one, or a new one of the document's handle class.
 */
export function deriveHandle(
  handle: Handle<any, any, any>,
  scope: unknown,
  heads: UrlHeads | undefined
): Handle<any, any, any> {
  const state = stateOf(handle)
  if (scope === undefined && !heads) return state.handle
  const scopeKey = scope === undefined ? "" : state.type.scopeKey?.(scope)
  const headsKey = heads ? [...heads].sort().join(",") : ""
  const key = `${scopeKey ?? ""}#${headsKey}`
  return state.handles.getOrCompute(
    key,
    () => new state.Handle(state, { heads, scope: scope as any })
  )
}

/**
 * The parts of a handle every document type has: identity, reading at the
 * current or fixed heads, the type's `change`, views, merging, deletion, and
 * events. Document types add their own members to it.
 */
export class Handle<
  S = unknown,
  X extends HandleExtensionSpec = {},
  E extends object = CoreHandleEvents,
> {
  static {
    stateOf = handle => handle.#state
    scopeOf = handle => handle.#scope
    fixedHeadsOf = handle => handle.#heads
  }

  /** Shared per-document state. Every handle into the same doc shares one. */
  readonly #state: DocumentState<any>
  /** If set, this handle shows the document only at these heads. */
  readonly #heads?: UrlHeads
  readonly #scope: unknown

  /** @internal Handles are obtained from a {@link Repo} or another handle. */
  constructor(state: DocumentState<any>, options: HandleOptions = {}) {
    this.#state = state
    this.#heads = options.heads
    this.#scope = options.scope
  }

  get documentId(): DocumentId {
    return this.#state.documentId
  }

  /** `<scheme>:<documentId>[#heads]` */
  get url(): DocumentUrl {
    return stringifyDocumentUrl({
      scheme: this.#state.type.scheme,
      documentId: this.documentId,
      heads: this.#heads,
    })
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
  doc(): unknown {
    return this.#state.type.value(this.#state.viewAt(this.#heads))
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
    return this.#state.type.hasHeads(
      this.#state.viewAt(this.#heads),
      decodeHeads(heads)
    )
  }

  /** A read-only handle to the document as of `heads`. */
  view(heads: UrlHeads): Handle<S, X, E> {
    return deriveHandle(this, this.#scope, heads) as Handle<S, X, E>
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
  change(change: unknown): Promise<void> {
    this.#throwIfFixedHeads("change")
    const state = this.#state
    return state.applyMutation(doc =>
      state.type.change(doc, change, state.context)
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
  merge(other: Handle<any, any, any>): Promise<void> {
    this.#throwIfFixedHeads("merge")
    const { type } = this.#state
    const otherState = other.#state
    if (otherState.type.scheme !== type.scheme)
      throw new Error(
        `Cannot merge a ${otherState.type.scheme} document into a ${type.scheme} document`
      )
    const incoming = otherState.viewAt(other.#heads)
    // A merge can bring many boundaries at once; store their fragments with it.
    return this.#state.applyMutation(doc => mergeStates(type, doc, incoming), {
      compact: true,
    })
  }

  /**
   * Marks the document deleted and fans `delete` out to every retained
   * handle. Prefer {@link Repo.delete} from user code.
   */
  delete() {
    this.#state.delete()
  }

  /** True if the other handle has the same URL as this one. */
  equals(other: Handle<any, any, any>): boolean {
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

  on<K extends keyof E>(event: K, fn: E[K]): this {
    this.#state.listeners.add(this, event as string, fn as any)
    return this
  }

  addListener<K extends keyof E>(event: K, fn: E[K]): this {
    return this.on(event, fn)
  }

  once<K extends keyof E>(event: K, fn: E[K]): this {
    this.#state.listeners.add(this, event as string, fn as any, true)
    return this
  }

  /**
   * @deprecated Handles are shared across the app, so this also removes
   * listeners other code added. Pass the listener to remove: `off(event, fn)`.
   */
  off<K extends keyof E>(event: K): this
  off<K extends keyof E>(event: K, fn: E[K] | undefined): this
  off<K extends keyof E>(event: K, fn?: E[K]): this {
    this.#state.listeners.remove(this, event as string, fn as any)
    return this
  }

  /**
   * @deprecated Handles are shared across the app, so this also removes
   * listeners other code added. Pass the listener to remove:
   * `removeListener(event, fn)`.
   */
  removeListener<K extends keyof E>(event: K): this
  removeListener<K extends keyof E>(event: K, fn: E[K] | undefined): this
  removeListener<K extends keyof E>(event: K, fn?: E[K]): this {
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
  listeners<K extends keyof E>(event: K): E[K][] {
    return this.#state.listeners.listeners(this, event as string) as E[K][]
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
  emit<K extends keyof E>(
    event: K,
    payload: E[K] extends (payload: infer P) => any ? P : never
  ): boolean {
    return this.#state.listeners.emit(this, event as string, payload)
  }
}
