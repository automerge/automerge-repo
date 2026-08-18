import { next as A } from "@automerge/automerge/slim"
import { makeLogger, Logger } from "./Logger.js"
import { decodeHeads } from "./AutomergeUrl.js"
import type { DocumentId, UrlHeads } from "./types.js"
import type { StorageId } from "./storage/types.js"
import type { SyncInfo } from "./DocHandle.js"
import { HandleRegistry } from "./subdoc-handles/handle-registry.js"
import { WeakValueMap } from "./helpers/WeakValueMap.js"
import {
  kOnRetainChange,
  kReleaseDocument,
  kRetainDocument,
  kSeverRetention,
} from "./internals.js"

/**
 * Per-document shared state - one per `documentId`, referenced by every
 * `DocHandle` (root, sub, view) into that document. Owns the Automerge
 * snapshot and the {@link HandleRegistry} (identity, pattern resolution,
 * listeners, dispatch). Not part of the public API.
 *
 * @internal
 */
export class Document<T = unknown> {
  readonly documentId: DocumentId
  readonly registry: HandleRegistry
  readonly log: Logger

  /** Current snapshot. Replaced (not mutated) by {@link applyMutation}. */
  doc: A.Doc<T>

  /** Set by {@link DocHandle.delete} on any handle into this document. */
  deleted = false

  /** Sync-info lookup injected by `Repo` from its `SyncStateTracker`. */
  syncInfoLookup?: (storageId: StorageId) => SyncInfo | undefined

  /**
   * External retainers: public `on`/`once` listeners plus external
   * {@link DocumentQuery} subscribers (including pending `whenReady`
   * waiters). Repo-internal subscriptions don't count - they exist for
   * every document.
   */
  #externalRetainCount = 0;

  /**
   * Injected by `Repo`: fired on the 0-to-1 / 1-to-0 transitions so the
   * Repo can root externally-observed documents.
   */
  [kOnRetainChange]?: (retained: boolean) => void;

  /** Record one external retainer (see `kOnRetainChange`). */
  [kRetainDocument](): void {
    if (++this.#externalRetainCount === 1) this[kOnRetainChange]?.(true)
  }

  /** Release one external retainer. Extra releases are ignored. */
  [kReleaseDocument](): void {
    if (this.#externalRetainCount === 0) return
    if (--this.#externalRetainCount === 0) this[kOnRetainChange]?.(false)
  }

  /**
   * Explicit teardown (`Repo.delete` / `removeFromCache`): drop all
   * external retention and stop reporting, so a detached document can
   * never re-root itself.
   */
  [kSeverRetention](): void {
    const wasRetained = this.#externalRetainCount > 0
    this.#externalRetainCount = 0
    if (wasRetained) this[kOnRetainChange]?.(false)
    this[kOnRetainChange] = undefined
  }

  /**
   * Materialized `A.view`s, keyed by heads. Heads precisely specify an
   * immutable state, so a view never changes once computed and the cache
   * never needs invalidating - the live doc only ever grows past these
   * heads, and `A.view` at a historical point is identical regardless.
   *
   * Held weakly: heads keys are unbounded over a document's life. A view
   * stays cached while held and is recomputed on a cold read.
   */
  #viewCache = new WeakValueMap<string, A.Doc<T>>()

  /**
   * @param syncInfoLookup - accepted here for direct construction (e.g.
   * tests). `Repo` cannot use it: its lookup closes over the root
   * `DocHandle`, which is constructed from this `Document` afterwards, so
   * `Repo` assigns {@link syncInfoLookup} post-construction instead.
   */
  constructor(
    documentId: DocumentId,
    initialDoc: A.Doc<T>,
    syncInfoLookup?: (storageId: StorageId) => SyncInfo | undefined
  ) {
    this.documentId = documentId
    this.doc = initialDoc
    this.syncInfoLookup = syncInfoLookup
    this.registry = new HandleRegistry(this)
    this.log = makeLogger(`automerge-repo:doc:${documentId.slice(0, 5)}`)
  }

  /**
   * The whole document at `heads` (the live snapshot when `heads` is
   * undefined). Views are memoized per snapshot so repeated reads from
   * view-pinned handles don't re-run `A.view`.
   */
  viewAt(heads: UrlHeads | undefined): A.Doc<T> {
    if (!heads) return this.doc
    const key = [...heads].sort().join(",")
    return this.#viewCache.getOrCompute(
      key,
      () => A.view(this.doc, decodeHeads(heads)) as A.Doc<T>
    )
  }

  /**
   * Run `mutator`, adopt its result, and fan `heads-changed` / `change`
   * out via the registry. No dispatch if heads didn't move. Pairing
   * mutation and dispatch here means callers can't forget the dispatch.
   */
  applyMutation(mutator: (doc: A.Doc<any>) => A.Doc<any>): void {
    const before = this.doc
    const after = mutator(before)
    // Always adopt the new snapshot even when heads are unchanged -
    // `A.change` can hand back a fresh snapshot whose `before` is now
    // "outdated" for subsequent mutations.
    this.doc = after
    const beforeHeads = A.getHeads(before)
    const afterHeads = A.getHeads(after)
    if (arrayEqual(beforeHeads, afterHeads)) return
    this.registry.dispatchHeadsChanged(after)
    const patches = A.diff(after, beforeHeads, afterHeads)
    if (patches.length > 0) {
      this.registry.dispatchChange(after, patches, {
        before,
        after,
        source: "change",
      })
    }
  }
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
