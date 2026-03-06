import { next as Automerge } from "@automerge/automerge/slim"
import type { DocumentSource } from "./DocumentSource.js"
import type { DocHandleEncodedChangePayload } from "./DocHandle.js"
import type { DocumentQuery } from "./DocumentQuery.js"
import type { StorageSubsystem } from "./storage/StorageSubsystem.js"
import type { DocumentId } from "./types.js"
import { throttle } from "./helpers/throttle.js"

/**
 * A {@link DocumentSource} backed by a {@link StorageSubsystem}. Loads
 * documents from storage on attach and saves on every heads-changed event
 * (throttled).
 */
export class StorageSource implements DocumentSource {
  #storage: StorageSubsystem
  #saveDebounceRate: number
  #saveFns: Record<
    DocumentId,
    (payload: DocHandleEncodedChangePayload<any>) => void
  > = {}

  constructor(storage: StorageSubsystem, saveDebounceRate: number) {
    this.#storage = storage
    this.#saveDebounceRate = saveDebounceRate
  }

  attach(query: DocumentQuery<unknown>): void {
    const handle = query.handle
    const saveFn = this.#makeSaveFn(handle.documentId)

    // Attach throttled save listener
    handle.on("heads-changed", saveFn)

    // If the handle already has data (e.g. from create/import), persist it
    // immediately rather than waiting for a future heads-changed event.
    if (handle.heads().length > 0) {
      saveFn({ handle, doc: handle.doc() })
      query.sourceUnavailable("storage")
      return
    }

    // Load from storage
    query.sourcePending("storage")
    void this.#storage.loadDoc(handle.documentId).then(doc => {
      if (doc && Automerge.getHeads(doc).length > 0) {
        handle.update(() => doc)
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
    if (!this.#saveFns[documentId]) {
      this.#saveFns[documentId] = throttle(
        ({ doc, handle }: DocHandleEncodedChangePayload<any>) => {
          void this.#storage.saveDoc(handle.documentId, doc)
        },
        this.#saveDebounceRate
      )
    }
    return this.#saveFns[documentId]
  }
}
