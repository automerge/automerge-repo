import { next as Automerge } from "@automerge/automerge/slim"
import type { DocumentSource } from "./DocumentSource.js"
import type { DocHandleEncodedChangePayload } from "./DocHandle.js"
import type { DocumentQuery, SourcePriority } from "./DocumentQuery.js"
import type { StorageSubsystem } from "./storage/StorageSubsystem.js"
import type { DocumentId } from "./types.js"
import { asyncThrottle } from "./helpers/throttle.js"

/**
 * A {@link DocumentSource} backed by a {@link StorageSubsystem}. Loads
 * documents from storage on attach and saves on every heads-changed event
 * (throttled).
 */
export class StorageSource implements DocumentSource {
  readonly priority: SourcePriority
  #storage: StorageSubsystem
  #saveDebounceRate: number
  #saveFns: Record<
    DocumentId,
    (payload: DocHandleEncodedChangePayload<any>) => void
  > = {}

  constructor(
    storage: StorageSubsystem,
    saveDebounceRate: number,
    { priority = 1 }: { priority?: SourcePriority } = {}
  ) {
    this.#storage = storage
    this.#saveDebounceRate = saveDebounceRate
    this.priority = priority
  }

  attach(query: DocumentQuery<unknown>): void {
    const handle = query.handle
    const saveFn = this.#makeSaveFn(handle.documentId)

    // Attach throttled save listener
    handle.on("heads-changed", saveFn)

    // If the handle already has data (e.g. from create/import), persist it
    // immediately rather than waiting for a future heads-changed event.
    if (handle.heads().length > 0) {
      saveFn({ handle, doc: handle.fullDoc() })
      query.sourceUnavailable("storage")
      return
    }

    // Load from storage
    query.sourcePending("storage")
    void this.#storage.loadDoc(handle.documentId).then(loaded => {
      if (loaded && Automerge.getHeads(loaded).length > 0) {
        // Sync may have delivered data while we were loading from disk —
        // merge instead of replacing to avoid clobbering newer state.
        handle.update(current =>
          Automerge.getHeads(current).length === 0
            ? loaded
            : Automerge.merge(current, loaded)
        )
        query.sourceReady("storage")
      } else {
        query.sourceUnavailable("storage")
      }
    })
  }

  detach(documentId: DocumentId): void {
    delete this.#saveFns[documentId]
  }

  #makeSaveFn(
    documentId: DocumentId
  ): (payload: DocHandleEncodedChangePayload<any>) => void {
    let fn = this.#saveFns[documentId]
    if (!fn) {
      fn = this.#saveFns[documentId] = asyncThrottle(
        ({ doc, handle }: DocHandleEncodedChangePayload<any>): Promise<void> =>
          this.#storage.saveDoc(handle.documentId, doc),
        this.#saveDebounceRate
      )
    }
    return fn
  }
}
