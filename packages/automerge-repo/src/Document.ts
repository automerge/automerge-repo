import { next as A } from "@automerge/automerge/slim"
import { makeLogger, Logger } from "./Logger.js"
import { decodeHeads, encodeHeads } from "./AutomergeUrl.js"
import type { DocumentId, UrlHeads } from "./types.js"
import type { StorageId, SyncInfo } from "./DocHandle.js"
import { HandleRegistry } from "./subdoc-handles/handle-registry.js"
import { WeakValueMap } from "./helpers/WeakValueMap.js"

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
  closed = false

  #syncInfo = new Map<StorageId, SyncInfo>()

  /** Capture local history synchronously, before reentrant listeners run. */
  commit?: (doc: A.Doc<any>) => Promise<void>
  #events: (() => void)[] = []
  #dispatching = false

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

  constructor(documentId: DocumentId, initialDoc: A.Doc<T>) {
    this.documentId = documentId
    this.doc = initialDoc
    this.registry = new HandleRegistry(this)
    this.log = makeLogger(`automerge-repo:doc:${documentId.slice(0, 5)}`)
  }

  getSyncInfo(storageId: StorageId): SyncInfo | undefined {
    return this.#syncInfo.get(storageId)
  }

  recordRemoteHeads(storageId: StorageId, heads: readonly string[]): void {
    const encoded = encodeHeads([...heads])
    const timestamp = Date.now()
    this.#syncInfo.set(storageId, {
      lastHeads: encoded,
      lastSyncTimestamp: timestamp,
    })
    this.registry.dispatchRemoteHeads(storageId, encoded, timestamp)
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
  applyMutation(
    mutator: (doc: A.Doc<any>) => A.Doc<any>,
    options: { incoming?: boolean } = {}
  ): Promise<void> {
    if (this.deleted) throw new Error("Document is deleted")
    if (this.closed) throw new Error("Document is closed")
    const before = this.doc
    const after = mutator(before)
    // Always adopt the new snapshot even when heads are unchanged -
    // `A.change` can hand back a fresh snapshot whose `before` is now
    // "outdated" for subsequent mutations.
    this.doc = after
    const beforeHeads = A.getHeads(before)
    const afterHeads = A.getHeads(after)
    const stored = options.incoming
      ? Promise.resolve()
      : (this.commit?.(after) ?? Promise.resolve())
    void stored.catch(() => {})
    if (arrayEqual(beforeHeads, afterHeads)) return stored
    const patches = A.diff(after, beforeHeads, afterHeads)
    this.#events.push(() => {
      this.registry.dispatchHeadsChanged(after)
      if (patches.length > 0) {
        this.registry.dispatchChange(after, patches, {
          before,
          after,
          source: "change",
        })
      }
    })
    if (!this.#dispatching) {
      this.#dispatching = true
      try {
        while (this.#events.length) this.#events.shift()!()
      } finally {
        this.#dispatching = false
      }
    }
    return stored
  }
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
