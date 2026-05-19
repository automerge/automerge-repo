import { next as A } from "@automerge/automerge/slim"
import debug from "debug"
import { encodeHeads } from "./AutomergeUrl.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import type { DocumentId } from "./types.js"
import type { StorageId } from "./storage/types.js"
import type { SyncInfo } from "./DocHandle.js"
import { HandleRegistry } from "./refs/handle-registry.js"

/**
 * Per-document shared state. One `Document` exists per documentId for as
 * long as the `Repo` is interested in that document; every `DocHandle`
 * into the document (whether root, sub-, or view-handle) holds a
 * reference to the same `Document`.
 *
 * `Document` owns the underlying Automerge data and the
 * {@link HandleRegistry} - which in turn manages handle identity,
 * pattern resolution, listener storage, and event dispatch.
 *
 * Mutations flow through `applyMutation`, which atomically updates the
 * doc and fans `heads-changed` / `change` out through the registry to
 * every affected handle in one trie walk per patch.
 *
 * Not part of the public API; users only ever see `DocHandle`.
 *
 * @internal
 */
export class Document<T = unknown> {
  readonly documentId: DocumentId
  readonly registry: HandleRegistry
  readonly log: debug.Debugger

  /** The underlying Automerge document. Mutated in place by `applyMutation`. */
  doc: A.Doc<T>

  /** Set to `true` when `DocHandle.delete()` is called. */
  deleted = false

  /**
   * Lookup for sync info, injected by `Repo` from its `SyncStateTracker`.
   * Shared by every handle into the document.
   */
  syncInfoLookup?: (storageId: StorageId) => SyncInfo | undefined

  constructor(
    documentId: DocumentId,
    initialDoc: A.Doc<T>,
    syncInfoLookup?: (storageId: StorageId) => SyncInfo | undefined
  ) {
    this.documentId = documentId
    this.doc = initialDoc
    this.syncInfoLookup = syncInfoLookup
    this.registry = new HandleRegistry(this)
    this.log = debug(`automerge-repo:doc:${documentId.slice(0, 5)}`)
  }

  /**
   * Apply a mutation to the doc, then fan out `heads-changed` and (if
   * the change has any patches) `change` events through the registry.
   * Pairing mutation and dispatch here means callers can't accidentally
   * forget the dispatch.
   */
  applyMutation(mutator: (doc: A.Doc<any>) => A.Doc<any>): void {
    const before = this.doc
    const after = mutator(before)
    this.doc = after
    const beforeHeads = A.getHeads(before)
    const afterHeads = A.getHeads(after)
    if (headsAreSame(encodeHeads(afterHeads), encodeHeads(beforeHeads))) {
      return
    }
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
