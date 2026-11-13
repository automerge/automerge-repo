import type { next as A } from "@automerge/automerge/slim"
import type { ExtendedHandle } from "./DocHandle.js"
import type { HandleExtension } from "./sedimentree/extension.js"
import type { PeerId, UrlHeads } from "./types.js"

/**
 * These are the events that this DocHandle emits to external listeners. `X`
 * names the handle's extensions; payloads carry the handle with them.
 */
export interface DocHandleEvents<T, X extends HandleExtension = never> {
  "heads-changed": (payload: DocHandleHeadsChangedPayload<T, X>) => void
  change: (payload: DocHandleChangePayload<T, X>) => void
  delete: (payload: DocHandleDeletePayload<T, X>) => void
  /**
   * A peer reported its heads. Reports received before the handle is ready
   * are delivered once, per peer with its latest heads, shortly after it
   * becomes ready; none are delivered if it never does.
   */
  "remote-heads": (payload: DocHandleRemoteHeadsPayload) => void
}

/** Emitted when this document's heads have changed */
export interface DocHandleHeadsChangedPayload<
  T,
  X extends HandleExtension = never,
> {
  handle: ExtendedHandle<T, X>
  doc: A.Doc<T>
}

/** @deprecated Use {@link DocHandleHeadsChangedPayload}. */
export type DocHandleEncodedChangePayload<
  T,
  X extends HandleExtension = never,
> = DocHandleHeadsChangedPayload<T, X>

/** Emitted when this document has changed */
export interface DocHandleChangePayload<T, X extends HandleExtension = never> {
  /** The handle that changed */
  handle: ExtendedHandle<T, X>
  /**
   * The value after the change, scoped to this handle. For a root handle
   * this is the whole document; for a sub-handle it is the value at the
   * handle's path (i.e. equal to `handle.doc()`). `undefined` when the
   * change removed the handle's scope.
   */
  doc: A.Doc<T> | undefined
  /**
   * The patches representing the change, with paths **relative to this
   * handle's scope**. For a root handle these are whole-document paths; for
   * a sub-handle they are re-rooted at the handle's path.
   */
  patches: A.Patch[]
  /**
   * `true` when the change replaced or removed this handle's scope wholesale
   * (a change at or above the scope boundary). Fine-grained consumers should
   * reconcile from `doc` rather than apply `patches` in this case. Always
   * `false` for a root handle.
   */
  scopeReplaced: boolean
  /**
   * Information about the change. Note: `before`/`after` here are
   * whole-document snapshots, not scoped.
   */
  patchInfo: A.PatchInfo<T>
}

/** Emitted when this document is deleted */
export interface DocHandleDeletePayload<T, X extends HandleExtension = never> {
  handle: ExtendedHandle<T, X>
}

/** Emitted when we have new remote heads for this document */
export interface DocHandleRemoteHeadsPayload {
  /** The peer whose heads these are, as the backend authenticated it. */
  peerId: PeerId
  heads: UrlHeads
  timestamp: number
}
