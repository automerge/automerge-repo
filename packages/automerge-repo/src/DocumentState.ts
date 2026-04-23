import type { DocHandle } from "./DocHandle.js"
import { SubHandleRegistry } from "./refs/sub-handle-registry.js"

/**
 * Internal container for state that is logically owned by the root document
 * rather than by any individual `DocHandle` instance.
 *
 * Every root `DocHandle` owns a `DocumentState`; sub-handles share a direct
 * reference to their root's `DocumentState`. This means every `DocHandle`
 * instance can access `this.#documentState.<thing>` without branching on
 * whether it is a root or a sub-handle - the root-vs-sub distinction stops
 * leaking through `(this.#root ?? this).<field>` patterns at call sites.
 *
 * This container exists primarily as a seam. Today it holds the caches and
 * dispatch-related state that the sub-handle registry will grow into. Over
 * time, more root-only state (the XState machine, the underlying document,
 * fixed heads, sync info, etc.) will migrate onto `DocumentState` as the
 * registry refactor lands and subsequent cleanups follow. Each such move is
 * mechanical because the seam is already in place.
 *
 * Not exported from the package barrel; this is an internal implementation
 * detail.
 */
export class DocumentState {
  /**
   * Cache for view handles, keyed by the stringified heads.
   *
   * Uses `WeakRef` so that time-travel UIs that open many `handle.view(heads)`
   * snapshots don't pin every historical handle in memory indefinitely.
   * Entries are pruned lazily on access.
   */
  viewCache: Map<string, WeakRef<DocHandle<any>>> = new Map()

  /** Cache for sub-handles, keyed by serialized path. */
  refCache: Map<string, WeakRef<DocHandle<any>>> = new Map()

  /**
   * Strong references to sub-handles that currently have at least one
   * listener attached. Sub-handles are otherwise held only as `WeakRef`s
   * in {@link refCache}, so without this set a user who calls
   * `handle.ref(...).on("change", cb)` without keeping a local reference to
   * the sub-handle could see the sub-handle (and their listener) silently
   * garbage-collected between events.
   */
  subHandleRetainers: Set<DocHandle<any>> = new Set()

  /**
   * Central dispatcher + retention tracker for sub-handles on this document.
   * Instantiated eagerly (cheap) so it can be used from sub-handle listener
   * hooks without a separate lazy-init dance. The registry is idempotently
   * attached to the root `DocHandle` via {@link SubHandleRegistry.attachTo}
   * the first time any sub-handle is created.
   */
  readonly registry: SubHandleRegistry = new SubHandleRegistry(this)
}
