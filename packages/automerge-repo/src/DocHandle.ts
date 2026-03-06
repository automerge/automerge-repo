import { next as A } from "@automerge/automerge/slim"
import { EventEmitter } from "eventemitter3"
import {
  decodeHeads,
  encodeHeads,
  stringifyAutomergeUrl,
} from "./AutomergeUrl.js"
import { encode } from "./helpers/cbor.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import type { AutomergeUrl, DocumentId, PeerId, UrlHeads } from "./types.js"
import { StorageId } from "./storage/types.js"
import { RefImpl } from "./refs/ref.js"
import type { PathInput, InferRefType, Ref } from "./refs/types.js"

/**
 * A DocHandle is a wrapper around a single Automerge document that lets us
 * listen for changes and notify the network and storage of new changes.
 *
 * A `DocHandle` represents a document which has data. You shouldn't ever
 * instantiate this yourself. To obtain `DocHandle` use {@link Repo.find} or
 * {@link Repo.create}.
 *
 * To modify the underlying document use either {@link DocHandle.change} or
 * {@link DocHandle.changeAt}. These methods will notify the `Repo` that some
 * change has occured and the `Repo` will save any new changes to the attached
 * {@link StorageAdapter} and send sync messages to connected peers.
 */
export class DocHandle<T> extends EventEmitter<DocHandleEvents<T>> {
  #doc: A.Doc<T>
  #refCache = new Map<string, WeakRef<RefImpl<T, any>>>()

  constructor(
    public documentId: DocumentId,
    options?: { isNew?: boolean }
  ) {
    super()
    if (options?.isNew) {
      this.#doc = A.emptyChange(A.init<T>())
    } else {
      this.#doc = A.init<T>()
    }
  }

  /** Our documentId in Automerge URL form. */
  get url(): AutomergeUrl {
    return stringifyAutomergeUrl({ documentId: this.documentId })
  }

  /** Returns the current Automerge document. */
  doc(): A.Doc<T> {
    return this.#doc
  }

  /** Returns the current "heads" of the document, akin to a git commit. */
  heads(): UrlHeads {
    return encodeHeads(A.getHeads(this.#doc))
  }

  /**
   * All changes to an Automerge document should be made through this method.
   */
  change(callback: A.ChangeFn<T>, options: A.ChangeOptions<T> = {}) {
    if (this.#fixedHeads) {
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads.`
      )
    }
    this.update(doc => A.change(doc, options, callback))
  }

  /**
   * Makes a change as if the document were at `heads`.
   * @returns A set of heads representing the concurrent change that was made.
   */
  changeAt(
    heads: UrlHeads,
    callback: A.ChangeFn<T>,
    options: A.ChangeOptions<T> = {}
  ): UrlHeads | undefined {
    let resultHeads: UrlHeads | undefined = undefined
    this.update(doc => {
      const result = A.changeAt(doc, decodeHeads(heads), options, callback)
      resultHeads = result.newHeads ? encodeHeads(result.newHeads) : undefined
      return result.newDoc
    })
    return resultHeads
  }

  merge(otherHandle: DocHandle<T>) {
    this.update(doc => A.merge(doc, otherHandle.doc()))
  }

  broadcast(message: unknown) {
    this.emit("ephemeral-message-outbound", {
      handle: this,
      data: new Uint8Array(encode(message)),
    })
  }

  /**
   * Returns a read-only DocHandle fixed at the given heads. Changes to the
   * view will throw an error.
   */
  view(heads: UrlHeads): DocHandle<T> {
    const handle = new DocHandle<T>(this.documentId)
    const viewDoc = A.view(this.#doc, decodeHeads(heads))
    handle.#doc = viewDoc
    handle.#fixedHeads = heads
    return handle
  }

  isReadOnly() {
    return !!this.#fixedHeads
  }

  /** Returns a resolved promise. Provided for API compatibility. */
  whenReady(): Promise<DocHandle<T>> {
    return Promise.resolve(this)
  }

  /** Called by the repo when the document is deleted. */
  delete() {
    this.emit("delete", { handle: this })
  }

  metrics(): { numOps: number; numChanges: number } {
    return A.stats(this.#doc)
  }

  /** @experimental */
  ref<TPath extends readonly PathInput[]>(
    ...segments: [...TPath]
  ): Ref<InferRefType<T, TPath>> {
    const cacheKey = this.#pathToCacheKey(segments)
    const existingRef = this.#refCache.get(cacheKey)?.deref()

    if (existingRef) {
      return existingRef as Ref<InferRefType<T, TPath>>
    }

    const newRef = new RefImpl<T, TPath>(this, segments as [...TPath])
    this.#refCache.set(cacheKey, new WeakRef(newRef))

    return newRef as Ref<InferRefType<T, TPath>>
  }

  #pathToCacheKey(segments: readonly PathInput[]): string {
    return segments
      .map(seg => {
        if (typeof seg === "string") return `s:${seg}`
        if (typeof seg === "number") return `n:${seg}`
        if (typeof seg === "object" && seg !== null) {
          return `o:${JSON.stringify(seg)}`
        }
        return `?:${String(seg)}`
      })
      .join("/")
  }

  #fixedHeads: UrlHeads | undefined

  /** @hidden */
  update(callback: (doc: A.Doc<T>) => A.Doc<T>) {
    if (this.#fixedHeads) {
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads.`
      )
    }
    const oldDoc = this.#doc
    this.#doc = callback(oldDoc)
    this.#emitChanges(oldDoc, this.#doc)
  }

  #emitChanges(before: A.Doc<T>, after: A.Doc<T>) {
    const beforeHeads = A.getHeads(before)
    const afterHeads = A.getHeads(after)
    const docChanged = !headsAreSame(
      encodeHeads(afterHeads),
      encodeHeads(beforeHeads)
    )
    if (docChanged) {
      this.emit("heads-changed", { handle: this, doc: after })

      const patches = A.diff(after, beforeHeads, afterHeads)
      if (patches.length > 0) {
        this.emit("change", {
          handle: this,
          doc: after,
          patches,
          patchInfo: { before, after, source: "change" },
        })
      }
    }
  }
}

//  TYPES

export interface DocHandleEvents<T> {
  "heads-changed": (payload: DocHandleEncodedChangePayload<T>) => void
  change: (payload: DocHandleChangePayload<T>) => void
  delete: (payload: DocHandleDeletePayload<T>) => void
  "ephemeral-message": (payload: DocHandleEphemeralMessagePayload<T>) => void
  "ephemeral-message-outbound": (
    payload: DocHandleOutboundEphemeralMessagePayload<T>
  ) => void
  "remote-heads": (payload: DocHandleRemoteHeadsPayload) => void
}

export interface DocHandleEncodedChangePayload<T> {
  handle: DocHandle<T>
  doc: A.Doc<T>
}

export interface DocHandleChangePayload<T> {
  handle: DocHandle<T>
  doc: A.Doc<T>
  patches: A.Patch[]
  patchInfo: A.PatchInfo<T>
}

export interface DocHandleDeletePayload<T> {
  handle: DocHandle<T>
}

export interface DocHandleEphemeralMessagePayload<T> {
  handle: DocHandle<T>
  senderId: PeerId
  message: unknown
}

export interface DocHandleOutboundEphemeralMessagePayload<T> {
  handle: DocHandle<T>
  data: Uint8Array
}

export interface DocHandleRemoteHeadsPayload {
  storageId: StorageId
  heads: UrlHeads
  timestamp: number
}

export type SyncInfo = {
  lastHeads: UrlHeads
  lastSyncTimestamp: number
}
