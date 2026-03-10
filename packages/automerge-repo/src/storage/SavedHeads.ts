import { next as A } from "@automerge/automerge/slim"
import { DocumentId } from "../types.js"
import { headsAreSame } from "../helpers/headsAreSame.js"
import { encodeHeads } from "../index.js"

/**
 * A cache of the last saved heads for each document
 *
 * The reason for using this class, rather than just a Map<DocumentId, Heads>,
 * is that we need to handle concurrent updates of the saved heads. This will
 * occur when for example you have a compaction running whilst a new incremental
 * save is begun. The incremental save can finish before the compaction and so
 * we need to express the fact that the update to the saved heads made by the
 * compaction should be ignored. We achieve this by maintaining a counter
 * representing the time that the update was begin, and only applying updates
 * to the saved heads if they are newer than the last update that was applied.
 */
export class SavedHeads {
  #seq: number = 0
  #data: Map<DocumentId, { heads: A.Heads; seq: number }> = new Map()

  /**
   * Get the last saved heads for a document
   */
  lastSavedHeads(documentId: DocumentId): HeadsHandle {
    return new HeadsHandle(documentId, ++this.#seq, this.#data)
  }
}

// Helpr class to manage applying heads updates in the correct order when there
// are concurrent saves
export class HeadsHandle {
  #documentId: DocumentId
  #seq: number
  #storedHeads: Map<DocumentId, { heads: A.Heads; seq: number }>
  #appliedHeads: A.Heads | null = null

  constructor(
    documentId: DocumentId,
    seq: number,
    storedHeads: Map<DocumentId, { heads: A.Heads; seq: number }>
  ) {
    this.#documentId = documentId
    this.#seq = seq
    this.#storedHeads = storedHeads
  }

  get value(): A.Heads | null {
    return this.#storedHeads.get(this.#documentId)?.heads ?? null
  }

  update(newHeads: A.Heads) {
    if (
      this.#appliedHeads &&
      !headsAreSame(encodeHeads(newHeads), encodeHeads(this.#appliedHeads))
    ) {
      throw new Error(
        "attempting to reuase a heads update with different heads"
      )
    }
    this.#appliedHeads = newHeads
    const currentSeq = this.#storedHeads.get(this.#documentId)?.seq ?? 0
    if (this.#seq >= currentSeq) {
      this.#storedHeads.set(this.#documentId, {
        heads: newHeads,
        seq: this.#seq,
      })
    }
  }
}
