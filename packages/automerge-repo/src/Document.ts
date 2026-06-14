import { next as A } from "@automerge/automerge/slim"
import { makeLogger, Logger } from "./Logger.js"
import { decodeHeads } from "./AutomergeUrl.js"
import type { DocumentId, PeerId, UrlHeads } from "./types.js"
import type { StorageId } from "./storage/types.js"
import type { SyncInfo } from "./DocHandle.js"
import { HandleRegistry } from "./subdoc-handles/handle-registry.js"
import {
  automergeDocType,
  type AnyDocumentType,
  type DocumentTypeContext,
  type StateOf,
} from "./crdt.js"

/**
 * Per-document shared state - one per `documentId`, referenced by every
 * `DocHandle` (root, sub, view) into that document. Owns the CRDT snapshot and
 * the {@link HandleRegistry} (identity, listeners, and Automerge sub-handle
 * dispatch). Not part of the public API.
 *
 * @internal
 */
export class Document<T = unknown> {
  readonly documentId: DocumentId
  readonly registry: HandleRegistry
  readonly log: Logger
  readonly crdtName: string
  readonly documentType: AnyDocumentType
  readonly context: DocumentTypeContext

  /** Current snapshot. Replaced (not mutated) by {@link applyMutation}. */
  doc: StateOf<T>

  /** Set by {@link DocHandle.delete} on any handle into this document. */
  deleted = false

  /** Sync-info lookup injected by `Repo` from its `SyncStateTracker`. */
  syncInfoLookup?: (storageId: StorageId) => SyncInfo | undefined

  /**
   * Materialized `A.view`s, keyed by heads. Heads precisely specify an
   * immutable state, so a view never changes once computed and the cache
   * never needs invalidating - the live doc only ever grows past these
   * heads, and `A.view` at a historical point is identical regardless.
   */
  #viewCache = new Map<string, StateOf<T>>()

  constructor(
    documentId: DocumentId,
    initialDoc: StateOf<T>,
    syncInfoLookup?: (storageId: StorageId) => SyncInfo | undefined,
    options: {
      documentType?: AnyDocumentType
      crdtName?: string
      peerId?: PeerId
    } = {}
  ) {
    this.documentId = documentId
    this.documentType = options.documentType ?? automergeDocType()
    this.crdtName = options.crdtName ?? this.documentType.name
    this.context = {
      documentId,
      crdtName: this.crdtName,
      peerId: options.peerId ?? ("peer-unknown" as PeerId),
    }
    this.doc = initialDoc
    this.syncInfoLookup = syncInfoLookup
    this.registry = new HandleRegistry(this)
    this.log = makeLogger(`automerge-repo:doc:${documentId.slice(0, 5)}`)
  }

  get isAutomerge(): boolean {
    return (this.documentType as any).kind === "automerge"
  }

  /**
   * The whole document at `heads` (the live snapshot when `heads` is
   * undefined). Views are memoized per snapshot so repeated reads from
   * view-pinned handles don't re-run `A.view`.
   */
  viewAt(heads: UrlHeads | undefined): StateOf<T> {
    if (!heads) return this.doc
    const rawHeads = decodeHeads(heads)
    const key = [...heads].sort().join(",")
    const canCache = this.hasHeads(rawHeads)
    const cached = canCache ? this.#viewCache.get(key) : undefined
    if (cached !== undefined) return cached

    let view: StateOf<T>
    if (this.isAutomerge) {
      view = A.view(this.doc as A.Doc<any>, rawHeads) as StateOf<T>
    } else if (this.documentType.viewAt) {
      view = this.documentType.viewAt(this.doc, rawHeads) as StateOf<T>
    } else {
      throw new Error(
        `Document type ${this.crdtName} does not support historical views`
      )
    }
    if (canCache) this.#viewCache.set(key, view)
    return view
  }

  rawHeads(): string[] {
    if (this.isAutomerge) return A.getHeads(this.doc as A.Doc<any>)
    return this.documentType.heads(this.doc)
  }

  hasData(): boolean {
    return this.documentType.hasData
      ? this.documentType.hasData(this.doc)
      : this.rawHeads().length > 0
  }

  hasHeads(heads: string[]): boolean {
    if (this.isAutomerge) return A.hasHeads(this.doc as A.Doc<any>, heads)
    return this.documentType.hasHeads?.(this.doc, heads) ?? false
  }

  /**
   * Run `mutator`, adopt its result, and fan `heads-changed` / `change`
   * out via the registry. No dispatch if heads didn't move. Pairing
   * mutation and dispatch here means callers can't forget the dispatch.
   */
  applyMutation(mutator: (doc: StateOf<T>) => StateOf<T>): void {
    const before = this.doc
    const beforeHeads = this.rawHeads()
    const after = mutator(before)
    // Always adopt the new snapshot even when heads are unchanged -
    // `A.change` can hand back a fresh snapshot whose `before` is now
    // "outdated" for subsequent mutations.
    this.doc = after
    const afterHeads = this.rawHeads()
    if (arrayEqual(beforeHeads, afterHeads)) return

    if (this.isAutomerge) {
      const automergeAfter = after as A.Doc<any>
      this.registry.dispatchHeadsChanged(automergeAfter)
      const patches = A.diff(automergeAfter, beforeHeads, afterHeads)
      if (patches.length > 0) {
        this.registry.dispatchChange(automergeAfter, patches, {
          before: before as A.Doc<any>,
          after: after as A.Doc<any>,
          source: "change",
        })
      }
      return
    }

    this.registry.dispatchGenericHeadsChanged(after)
    this.registry.dispatchGenericChange(after, {
      before,
      after,
      source: "change",
    })
  }
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
