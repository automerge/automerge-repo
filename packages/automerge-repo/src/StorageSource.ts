import { next as Automerge } from "@automerge/automerge/slim"
import { makeLogger } from "./Logger.js"
import type { DocumentSource } from "./DocumentSource.js"
import type { DocHandleEncodedChangePayload } from "./DocHandle.js"
import type { DocumentQuery, SourcePriority } from "./DocumentQuery.js"
import type { StorageSubsystem } from "./storage/StorageSubsystem.js"
import type { DocumentId } from "./types.js"
import { asyncThrottle } from "./helpers/throttle.js"
import { WeakValueMap } from "./helpers/WeakValueMap.js"
import { kOnInternal } from "./internals.js"

/**
 * A {@link DocumentSource} backed by a {@link StorageSubsystem}. Loads
 * documents from storage on attach and saves on every heads-changed event
 * (throttled).
 */
export class StorageSource implements DocumentSource {
  readonly priority: SourcePriority
  #storage: StorageSubsystem
  #saveDebounceRate: number
  /**
   * Per-document throttled save listeners, held weakly. Each saveFn is
   * retained by its own document cluster (it's a heads-changed listener,
   * and a pending throttle timer pins it until the write lands), so an
   * entry evicts itself once the document is collected.
   */
  #saveFns = new WeakValueMap<
    DocumentId,
    (payload: DocHandleEncodedChangePayload<any>) => void
  >()
  #log = makeLogger("automerge-repo:storage-source")

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

    // Attach throttled save listener (internal: doesn't retain the document)
    handle[kOnInternal]("heads-changed", saveFn)

    // If the handle already has data (e.g. from create/import), persist it
    // immediately rather than waiting for a future heads-changed event.
    if (Automerge.getHeads(handle.fullDoc()).length > 0) {
      saveFn({ handle, doc: handle.fullDoc() })
      query.sourceUnavailable("storage")
      return
    }

    // Load from storage
    query.sourcePending("storage")
    void this.#storage
      .loadDoc(handle.documentId)
      .then(loaded => {
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
      .catch(err => {
        // A failed storage read (or a throw while applying the loaded data)
        // means this source can't provide the document. Mark it unavailable so
        // the query can settle instead of hanging in `pending`, and surface the
        // error rather than dropping it as an unhandled rejection. Other
        // sources (e.g. sync) may still deliver the document.
        this.#log.error(
          `Error loading document ${handle.documentId} from storage`,
          err
        )
        query.sourceUnavailable("storage")
      })
  }

  detach(documentId: DocumentId): void {
    this.#saveFns.delete(documentId)
  }

  #makeSaveFn(
    documentId: DocumentId
  ): (payload: DocHandleEncodedChangePayload<any>) => void {
    let fn = this.#saveFns.get(documentId)
    if (!fn) {
      fn = asyncThrottle(
        async ({
          doc,
          handle,
        }: DocHandleEncodedChangePayload<any>): Promise<void> => {
          try {
            await this.#storage.saveDoc(handle.documentId, doc)
          } catch (err) {
            // This save runs fire-and-forget from a "heads-changed" listener,
            // so a rejection would surface as an unhandled rejection and, in
            // Node, exit the process by default. Catch and log it; the change
            // stays in memory and a later save or reload can re-persist it.
            // See https://nodejs.org/api/process.html#event-unhandledrejection
            this.#log.error(
              `Error saving document ${handle.documentId} to storage`,
              err
            )
          }
        },
        this.#saveDebounceRate
      )
      this.#saveFns.set(documentId, fn)
    }
    return fn
  }
}
