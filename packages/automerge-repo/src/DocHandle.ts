import { next as A } from "@automerge/automerge/slim"
import type { Prop } from "@automerge/automerge/slim"
import { EventEmitter } from "eventemitter3"
import {
  decodeHeads,
  encodeHeads,
  stringifyAutomergeUrl,
} from "./AutomergeUrl.js"
import type { AutomergeUrl, DocumentId, PeerId, UrlHeads } from "./types.js"
import type { StorageId } from "./storage/types.js"
import {
  DocumentState,
  HandleState,
  IDLE,
  LOADING,
  REQUESTING,
  READY,
  UNLOADED,
  DELETED,
  UNAVAILABLE,
} from "./DocumentState.js"
import type {
  SyncInfo,
} from "./DocumentState.js"
import { AbortOptions } from "./helpers/abortable.js"
import { isCursorMarker, isPattern, isSegment } from "./refs/guards.js"
import { matchesPattern } from "./refs/utils.js"
import {
  applyScopedChange as applyScopedChangeOp,
  applyScopedRemove as applyScopedRemoveOp,
  getPropPath as getPropPathFromSegments,
  resolvePropPathAt,
  resolveSegmentProp,
  scopedValue as scopedValueOp,
} from "./refs/sub-handle-ops.js"
import type {
  AnyPathInput,
  ChangeFn as RefChangeFn,
  CursorRange,
  InferRefType,
  PathInput,
  PathSegment,
  Pattern,
  Segment,
} from "./refs/types.js"
import { KIND } from "./refs/types.js"

// Re-export lifecycle state + sync types from DocumentState so existing
// consumers (`import { HandleState, SyncInfo } from "./DocHandle.js"`)
// continue to compile.
export {
  HandleState,
  IDLE,
  LOADING,
  REQUESTING,
  READY,
  UNLOADED,
  DELETED,
  UNAVAILABLE,
}
export type { SyncInfo }

/**
 * A DocHandle is a view into a single Automerge document. It lets you
 * read the document, listen for changes, and apply mutations.
 *
 * @remarks
 * `DocHandle`s are managed by a {@link Repo}; obtain one via {@link Repo.find}
 * or {@link Repo.create} rather than instantiating directly.
 *
 * To modify the underlying document use {@link DocHandle.change} or
 * {@link DocHandle.changeAt}. These notify the {@link Repo}, which saves
 * the new changes via the attached {@link StorageAdapter} and sends sync
 * messages to connected peers.
 *
 * Internally, a `DocHandle` is a `(documentState, path, range, fixedHeads)`
 * tuple. Root handles allocate a `DocumentState` (the XState machine, the
 * underlying doc, sync info, and sub-handle registry); sub-handles and
 * view-handles share their root's. Sub-handles are scoped to a path or
 * range, and any handle can pin to fixed heads independently of its root.
 */
export class DocHandle<T> extends EventEmitter<DocHandleEvents<T>> {
  /**
   * If set, this handle shows the document at these specific heads rather
   * than the latest. Stored per-handle (not on `DocumentState`) so that a
   * sub-handle can be pinned to arbitrary heads independent of its root -
   * e.g. a historical view of a sub-tree while the root tracks head.
   */
  #fixedHeads?: UrlHeads

  /**
   * Every DocHandle into a given Automerge document shares the same
   * `DocumentState`. The container owns the XState machine, the underlying
   * doc, remote sync info, and the sub-handle registry. Root handles
   * construct their own; sub-handles and view-handles share it.
   */
  readonly documentState: DocumentState

  /**
   * On a sub-handle, points at the root handle this sub was derived from.
   * `undefined` on root handles. Used to compose paths through chained
   * `ref()` calls and to inherit fixed heads via {@link #effectiveFixedHeads}.
   */
  #root?: DocHandle<any>

  /** Path segments for sub-handles; empty array for root handles. */
  #path: PathSegment[] = []

  /** Cursor range for text-range sub-handles. */
  #range?: CursorRange

  /** @hidden */
  constructor(
    public documentId: DocumentId,
    options: DocHandleOptions<T> = {}
  ) {
    super()

    if ("heads" in options && options.heads) {
      this.#fixedHeads = options.heads
    }

    // Sub-handle: share the parent's DocumentState and normalise the path
    // inputs. Sub-handles receive events via the registry's trie walk
    // against the shared DocumentState - no per-sub listeners attached.
    if ("root" in options && options.root) {
      this.#root = options.root
      this.documentState = options.root.documentState
      const rootDoc = options.root.isReady() ? options.root.doc() : undefined
      const { path, range } = this.#normalizePath(
        rootDoc as A.Doc<any>,
        (options.pathInputs ?? []) as AnyPathInput[]
      )
      this.#path = path
      this.#range = range
      return
    }

    // Root: allocate a `DocumentState` and re-emit its document-level
    // events as handle-shaped ones. The registry subscribes to the same
    // events independently to fan out to sub-handle terminals.
    this.documentState = new DocumentState(documentId, {
      timeoutDelay:
        "timeoutDelay" in options ? options.timeoutDelay : undefined,
    })

    // Frozen handles (those pinned to `#fixedHeads`) suppress `change` and
    // `heads-changed`: their `value()` can never reflect a future change.
    // Lifecycle and ephemeral events still fire - they're document-level.
    this.documentState.on("change", payload => {
      if (this.#fixedHeads) return
      this.emit("change", { handle: this, ...payload })
    })
    this.documentState.on("heads-changed", payload => {
      if (this.#fixedHeads) return
      this.emit("heads-changed", { handle: this, ...payload })
    })
    this.documentState.on("delete", () =>
      this.emit("delete", { handle: this })
    )
    this.documentState.on("remote-heads", payload =>
      this.emit("remote-heads", payload)
    )
    this.documentState.on("ephemeral-message", payload =>
      this.emit("ephemeral-message", { handle: this, ...payload })
    )
    this.documentState.on("ephemeral-message-outbound", payload =>
      this.emit("ephemeral-message-outbound", { handle: this, ...payload })
    )

    this.begin()
  }

  // PRIVATE

  /** The current underlying root document, shared via `DocumentState`. */
  get #doc(): A.Doc<any> {
    return this.documentState.doc()
  }

  /** True when this handle is scoped to a path/range within the root. */
  get #isSubHandle(): boolean {
    return this.#root !== undefined
  }

  /**
   * The fixed heads this handle reads at, if any: own `#fixedHeads` if
   * set, otherwise inherited from the root. Per-handle heads take
   * precedence so a sub can be pinned independently of its root.
   */
  get #effectiveFixedHeads(): UrlHeads | undefined {
    if (this.#fixedHeads) return this.#fixedHeads
    // Optional chaining doesn't reach private fields; null-check directly.
    return this.#root === undefined ? undefined : this.#root.#fixedHeads
  }

  /**
   * Throws on sub-handles. Used by lifecycle methods that only make sense
   * on the root: sub-handles don't drive the document's lifecycle, the
   * Repo does, and the Repo always holds the root.
   */
  #requireRoot(method: string): void {
    if (this.#root) {
      throw new Error(
        `${method}() is only valid on root document handles; use \`handle.docHandle\` to get the root.`
      )
    }
  }

  // PUBLIC

  /** This handle's URL. For root handles this is `automerge:<docId>[#heads]`; for sub-handles
   * the URL includes the path segments and any fixed heads from the root view.
   */
  get url(): AutomergeUrl {
    const segments: Segment[] | undefined =
      this.#path.length > 0 || this.#range
        ? this.#range
          ? [...(this.#path as Segment[]), this.#range]
          : (this.#path as Segment[])
        : undefined
    return stringifyAutomergeUrl({
      documentId: this.documentId,
      heads: this.#effectiveFixedHeads,
      segments,
    })
  }

  /**
   * @returns true if the document is ready for accessing or changes.
   *
   * Note that for documents already stored locally this occurs before synchronization with any
   * peers. We do not currently have an equivalent `whenSynced()`.
   */
  isReady = () => this.inState(["ready"])

  /**
   * @returns true if the document has been unloaded.
   *
   * Unloaded documents are freed from memory but not removed from local storage. It's not currently
   * possible at runtime to reload an unloaded document.
   */
  isUnloaded = () => this.inState(["unloaded"])

  /**
   * @returns true if the document has been marked as deleted.
   *
   * Deleted documents are removed from local storage and the sync process. It's not currently
   * possible at runtime to undelete a document.
   */
  isDeleted = () => this.inState(["deleted"])

  /**
   * @returns true if the document is currently unavailable.
   *
   * This will be the case if the document is not found in storage and no peers have shared it with us.
   */
  isUnavailable = () => this.inState(["unavailable"])

  /**
   * @returns true if the handle is in one of the given states.
   */
  inState = (states: HandleState[]): boolean => {
    return this.documentState.inState(states)
  }

  /** @hidden */
  get state(): HandleState {
    return this.documentState.state()
  }

  /**
   * Returns promise that resolves when document is in one of the given states (default is 'ready' state)
   *
   * Use this to block until the document handle has finished loading. The async equivalent to
   * checking `inState()`.
   *
   * @param awaitStates - HandleState or HandleStates to wait for
   * @param signal - Optional AbortSignal to cancel the waiting operation
   * @returns a promise that resolves when the document is in one of the given states (if no states
   * are passed, when the document is ready)
   */
  async whenReady(
    awaitStates: HandleState[] = ["ready"],
    options?: AbortOptions
  ): Promise<void> {
    try {
      await this.documentState.whenInState(awaitStates, options)
    } catch (error) {
      console.log(
        `error waiting for ${
          this.documentId
        } to be in one of states: ${awaitStates.join(", ")}`
      )
      throw error
    }
  }

  /**
   * Returns the current Automerge document.
   *
   * For both root handles and sub-handles this returns the *whole* underlying document
   * (at the sub-handle's pinned heads, if any). To get the value at a sub-handle's
   * path (i.e. scoped to its sub-tree), use {@link DocHandle.value}.
   *
   * @throws if the handle is not ready
   */
  doc(): A.Doc<any> {
    if (!this.isReady()) throw new Error("DocHandle is not ready")
    const heads = this.#effectiveFixedHeads
    const underlying = this.#doc
    return (heads ? A.view(underlying, decodeHeads(heads)) : underlying) as A.Doc<any>
  }

  /**
   * Returns the scoped value this handle points to. For a root handle this is identical
   * to {@link DocHandle.doc}. For a sub-handle, this returns the value at the handle's
   * path (or the substring within a cursor range). Returns `undefined` if the path
   * cannot be resolved.
   */
  value(): T | undefined {
    const doc = this.doc()
    if (this.#path.length === 0 && !this.#range) {
      return doc as T
    }
    return this.#scopedValue(doc) as T | undefined
  }

  /**
   *
   * @deprecated */
  docSync() {
    console.warn(
      "docSync is deprecated. Use doc() instead. This function will be removed as part of the 2.0 release."
    )
    return this.doc()
  }

  /**
   * Returns the current "heads" of the underlying document, akin to a git commit.
   * For sub-handles this returns the root document's heads — heads are a document-level
   * concept. To see heads where this sub-handle's path changed, use {@link history}.
   * @returns the current document's heads, or undefined if the document is not ready
   */
  heads(): UrlHeads {
    if (!this.isReady()) throw new Error("DocHandle is not ready")
    const heads = this.#effectiveFixedHeads
    if (heads) return heads
    return encodeHeads(A.getHeads(this.#doc))
  }

  begin() {
    this.#requireRoot("begin")
    this.documentState.begin()
  }

  /**
   * Returns an array of all past "heads" for the document in topological order.
   *
   * @remarks
   * A point-in-time in an automerge document is an *array* of heads since there may be
   * concurrent edits. This API just returns a topologically sorted history of all edits
   * so every previous entry will be (in some sense) before later ones, but the set of all possible
   * history views would be quite large under concurrency (every thing in each branch against each other).
   * There might be a clever way to think about this, but we haven't found it yet, so for now at least
   * we present a single traversable view which excludes concurrency.
   * @returns UrlHeads[] - The individual heads for every change in the document. Each item is a tagged string[1].
   */
  history(): UrlHeads[] | undefined {
    if (!this.isReady()) {
      return undefined
    }

    const topo = A.topoHistoryTraversal(this.#doc)

    if (this.#path.length === 0 && !this.#range) {
      return topo.map(h => encodeHeads([h])) as UrlHeads[]
    }

    // For pattern-based sub-handles the resolved prop path can change
    // over history. Resolve the symbolic path against each step's snapshot
    // independently, both "before" and "after", so patches that create
    // the target (resolvable only after) or destroy it (only before) are
    // both captured.
    const segments = this.#path
    const out: UrlHeads[] = []
    for (let i = 0; i < topo.length; i++) {
      const after = [topo[i]]
      const before = i === 0 ? [] : [topo[i - 1]]
      const patches = A.diff(this.#doc, before, after)

      const beforePath =
        before.length === 0
          ? undefined
          : resolvePropPathAt(
              A.view(this.#doc, before) as A.Doc<any>,
              segments
            )
      const afterPath = resolvePropPathAt(
        A.view(this.#doc, after) as A.Doc<any>,
        segments
      )
      if (!beforePath && !afterPath) continue

      const overlaps = patches.some(
        p =>
          (beforePath !== undefined && pathsOverlap(p.path, beforePath)) ||
          (afterPath !== undefined && pathsOverlap(p.path, afterPath))
      )
      if (overlaps) {
        out.push(encodeHeads([topo[i]]) as UrlHeads)
      }
    }
    return out
  }

  /**
   * Creates a fixed "view" of an automerge document at the given point in time represented
   * by the `heads` passed in. The return value is the same type as doc() and will return
   * undefined if the object hasn't finished loading.
   *
   * @remarks
   * Note that our Typescript types do not consider change over time and the current version
   * of Automerge doesn't check types at runtime, so if you go back to an old set of heads
   * that doesn't match the heads here, Typescript will not save you.
   *
   * @argument heads - The heads to view the document at. See history().
   * @returns DocHandle<T> at the time of `heads`
   */
  view(heads: UrlHeads): DocHandle<T> {
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is not ready. Check \`handle.isReady()\` before calling view().`
      )
    }
    // A view-at-heads is the same handle pinned to `heads`. Routing
    // through `#createSubHandle` gives stable identity across both
    // `root.view(h).ref("x")` and `root.ref("x").view(h)`.
    return this.#createSubHandle([], { heads }) as DocHandle<T>
  }

  /**
   * Returns a set of Patch operations that will move a materialized document from one state to another
   * if applied.
   *
   * @remarks
   * We allow specifying either:
   * - Two sets of heads to compare directly
   * - A single set of heads to compare against our current heads
   * - Another DocHandle to compare against (which must share history with this document)
   *
   * @throws Error if the documents don't share history or if either document is not ready
   * @returns Automerge patches that go from one document state to the other
   */
  diff(first: UrlHeads | DocHandle<T>, second?: UrlHeads): A.Patch[] {
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is not ready. Check \`handle.isReady()\` before calling diff().`
      )
    }

    // Default `from` to this handle's own heads (which honour fixedHeads).
    // A view-at-heads handle thus diffs from its pinned heads to X, not
    // from the live latest.
    let fromHeads: UrlHeads
    let toHeads: UrlHeads
    let diffDoc: A.Doc<any>

    if (first instanceof DocHandle) {
      if (!first.isReady()) {
        throw new Error("Cannot diff against a handle that isn't ready")
      }
      const otherHeads = first.heads()
      if (!otherHeads) throw new Error("Other document's heads not available")

      fromHeads = this.heads()
      toHeads = otherHeads

      if (this.documentId === first.documentId) {
        // Same document (possibly different handles) - share the doc, no clone.
        diffDoc = this.documentState.doc()
      } else {
        // Different documents: merge them first to verify shared history.
        diffDoc = A.merge(A.clone(this.documentState.doc()), first.doc()!)
      }
    } else {
      fromHeads = second ? first : this.heads()
      toHeads = second ? second : first
      diffDoc = this.documentState.doc()
    }

    const allPatches = A.diff(
      diffDoc,
      decodeHeads(fromHeads),
      decodeHeads(toHeads)
    )

    if (this.#path.length === 0 && !this.#range) return allPatches

    // Sub-handle: filter to patches overlapping the sub's path, resolved
    // against both endpoint snapshots so patches that create or destroy
    // the target (present before-only or after-only) are both captured.
    const fromDoc = A.view(diffDoc, decodeHeads(fromHeads)) as A.Doc<any>
    const toDoc = A.view(diffDoc, decodeHeads(toHeads)) as A.Doc<any>
    const fromPath = resolvePropPathAt(fromDoc, this.#path)
    const toPath = resolvePropPathAt(toDoc, this.#path)
    if (!fromPath && !toPath) return []
    return allPatches.filter(
      p =>
        (fromPath !== undefined && pathsOverlap(p.path, fromPath)) ||
        (toPath !== undefined && pathsOverlap(p.path, toPath))
    )
  }

  /**
   * `metadata(head?)` allows you to look at the metadata for a change
   * this can be used to build history graphs to find commit messages and edit times.
   * this interface.
   *
   * @remarks
   * I'm really not convinced this is the right way to surface this information so
   * I'm leaving this API "hidden".
   *
   * @hidden
   */
  metadata(change?: string): A.DecodedChange | undefined {
    return this.documentState.metadata(change)
  }

  /**
   * `update` is called any time we have a new document state; could be
   * from a local change, a remote change, or a new document from storage.
   * Does not cause state changes.
   * @hidden
   */
  update(callback: (doc: A.Doc<T>) => A.Doc<T>) {
    this.#requireRoot("update")
    this.documentState.update(callback as (doc: A.Doc<any>) => A.Doc<any>)
  }

  /**
   * `doneLoading` is called by the repo after it decides it has all the changes
   * it's going to get during setup. This might mean it was created locally,
   * or that it was loaded from storage, or that it was received from a peer.
   */
  doneLoading() {
    this.#requireRoot("doneLoading")
    this.documentState.doneLoading()
  }

  /**
   * Called by the repo when a doc handle changes or we receive new remote heads.
   * @hidden
   */
  setSyncInfo(storageId: StorageId, syncInfo: SyncInfo): void {
    this.documentState.setSyncInfo(storageId, syncInfo)
  }

  /** Returns the heads of the storageId.
   *
   * @deprecated Use getSyncInfo instead.
   */
  getRemoteHeads(storageId: StorageId): UrlHeads | undefined {
    return this.documentState.getRemoteHeads(storageId)
  }

  /** Returns the heads and the timestamp of the last update for the storageId. */
  getSyncInfo(storageId: StorageId): SyncInfo | undefined {
    return this.documentState.getSyncInfo(storageId)
  }

  /**
   * All changes to an Automerge document should be made through this method.
   * Inside the callback, the document should be treated as mutable: all edits will be recorded
   * using a Proxy and translated into operations as part of a single recorded "change".
   *
   * Note that assignment via ES6 spread operators will result in *replacing* the object
   * instead of mutating it which will prevent clean merges. This may be what you want, but
   * `doc.foo = { ...doc.foo, bar: "baz" }` is not equivalent to `doc.foo.bar = "baz"`.
   *
   * Local changes will be stored (by the StorageSubsystem) and synchronized (by the
   * DocSynchronizer) to any peers you are sharing it with.
   *
   * @param callback - A function that takes the current document and mutates it.
   *
   */
  change(
    callback: A.ChangeFn<T> | T,
    options: A.ChangeOptions<T> = {}
  ): void {
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is in ${this.state} and not ready. Check \`handle.isReady()\` before accessing the document.`
      )
    }

    if (this.isReadOnly()) {
      if (this.#isSubHandle) {
        throw new Error("Cannot change a Ref on a read-only handle")
      }
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }

    if (this.#isSubHandle || this.#range) {
      // Coerce direct value (shorthand) to a function form.
      const fn = (
        typeof callback === "function" ? callback : () => callback
      ) as RefChangeFn<T>
      this.documentState.change(
        ((doc: A.Doc<any>) => this.#applyScopedChange(doc, fn)) as A.ChangeFn<
          any
        >,
        options as A.ChangeOptions<any>
      )
      return
    }

    this.documentState.change(
      callback as A.ChangeFn<any>,
      options as A.ChangeOptions<any>
    )
  }
  /**
   * Makes a change as if the document were at `heads`.
   *
   * @returns A set of heads representing the concurrent change that was made.
   */
  changeAt(
    heads: UrlHeads,
    callback: A.ChangeFn<T>,
    options: A.ChangeOptions<T> = {}
  ): UrlHeads | undefined {
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is not ready. Check \`handle.isReady()\` before accessing the document.`
      )
    }
    if (this.#effectiveFixedHeads) {
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }

    if (this.#isSubHandle || this.#range) {
      // Scope the callback to this handle's path; DocumentState handles
      // the concurrent-change semantics.
      return this.documentState.changeAt(
        heads,
        ((doc: A.Doc<any>) =>
          this.#applyScopedChange(doc, callback as RefChangeFn<T>)) as A.ChangeFn<
          any
        >,
        options as A.ChangeOptions<any>
      )
    }

    return this.documentState.changeAt(
      heads,
      callback as A.ChangeFn<any>,
      options as A.ChangeOptions<any>
    )
  }

  /**
   * Check if the document can be change()ed. Currently, documents can be
   * edited unless we are viewing a particular point in time.
   *
   * @remarks It is technically possible to back-date changes using changeAt(),
   *          but we block it for usability reasons when viewing a particular point in time.
   *          To make changes in the past, use the primary document handle with no heads set.
   *
   * @returns boolean indicating whether changes are possible
   */
  isReadOnly(): boolean {
    return !!this.#effectiveFixedHeads
  }

  /**
   * Merges another document into this document. Any peers we are sharing changes with will be
   * notified of the changes resulting from the merge.
   *
   * @returns the merged document.
   *
   * @throws if either document is not ready or if `otherHandle` is unavailable.
   */
  merge(
    /** the handle of the document to merge into this one */
    otherHandle: DocHandle<T>
  ) {
    this.#requireRoot("merge")
    if (!this.isReady() || !otherHandle.isReady()) {
      throw new Error("Both handles must be ready to merge")
    }
    if (this.#fixedHeads) {
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }
    const mergingDoc = otherHandle.doc()

    this.update(doc => {
      return A.merge(doc, mergingDoc)
    })
  }

  /**
   * Updates the internal state machine to mark the document unavailable.
   * @hidden
   */
  unavailable() {
    this.#requireRoot("unavailable")
    this.documentState.unavailable()
  }

  /**
   * Called by the repo either when the document is not found in storage.
   * @hidden
   * */
  request() {
    this.#requireRoot("request")
    this.documentState.request()
  }

  /** Called by the repo to free memory used by the document. */
  unload() {
    this.#requireRoot("unload")
    this.documentState.unload()
  }

  /** Called by the repo to reuse an unloaded handle. */
  reload() {
    this.#requireRoot("reload")
    this.documentState.reload()
  }

  /** Called by the repo when the document is deleted. */
  delete() {
    this.#requireRoot("delete")
    this.documentState.delete()
  }

  /**
   * Sends an arbitrary ephemeral message out to all reachable peers who would receive sync messages
   * from you. It has no guarantee of delivery, and is not persisted to the underlying automerge doc
   * in any way. Messages will have a sending PeerId but this is *not* a useful user identifier (a
   * user could have multiple tabs open and would appear as multiple PeerIds). Every message source
   * must have a unique PeerId.
   */
  broadcast(message: unknown): void {
    this.documentState.broadcast(message)
  }

  metrics(): { numOps: number; numChanges: number } {
    return this.documentState.metrics()
  }

  /**
   * The root handle for this sub-handle, or this handle itself if it is a root/view handle.
   * This is the "document owner" and is always the handle under which sub-handles are created.
   */
  get docHandle(): DocHandle<any> {
    return this.#root ?? this
  }

  /** The resolved path segments for this handle (empty for root handles). */
  get path(): PathSegment[] {
    return this.#path
  }

  /** The cursor range for this handle, if any. */
  get range(): CursorRange | undefined {
    return this.#range
  }

  /**
   * Returns `[startIndex, endIndex]` for the current cursor range, resolved against the
   * current text value, or `undefined` if this handle has no range.
   */
  rangePositions(): [number, number] | undefined {
    if (!this.#range) return undefined
    const heads = this.#effectiveFixedHeads
    const rootDoc = heads ? A.view(this.#doc, decodeHeads(heads)) : this.#doc
    const propPath = this.#getPropPath()
    if (!propPath) return undefined
    const textPath = propPath
    try {
      const start = A.getCursorPosition(
        rootDoc,
        textPath,
        this.#range.start as A.Cursor
      )
      const end = A.getCursorPosition(
        rootDoc,
        textPath,
        this.#range.end as A.Cursor
      )
      return [start, end]
    } catch {
      return undefined
    }
  }

  /**
   * Create a sub-handle scoped to a location inside this document.
   *
   * Returns the same instance for the same path, ensuring referential equality.
   *
   * @example
   * ```ts
   * const titleRef = handle.ref('todos', 0, 'title');
   * titleRef.doc(); // string | undefined
   *
   * const sameRef = handle.ref('todos', 0, 'title');
   * titleRef === sameRef; // true
   * ```
   */
  ref<TPath extends readonly PathInput[]>(
    ...segments: [...TPath]
  ): DocHandle<InferRefType<T, TPath>> {
    return this.#createSubHandle(segments) as DocHandle<
      InferRefType<T, TPath>
    >
  }


  /** Removes the value at this sub-handle's path from the underlying document. */
  remove(): void {
    if (this.#path.length === 0 && !this.#range) {
      throw new Error("Cannot remove the root document")
    }
    if (this.isReadOnly()) {
      throw new Error("Cannot remove from a Ref on a read-only handle")
    }
    const rootHandle = this.#root ?? this
    rootHandle.change(((doc: A.Doc<any>) => this.#applyScopedRemove(doc)) as A.ChangeFn<any>)
  }

  /** True if the other handle has the same URL as this one. */
  equals(other: DocHandle<any>): boolean {
    return this.url === other.url
  }

  /**
   * True if this handle's path is a strict ancestor of `other`'s path, within the same
   * document and view (heads).
   */
  contains(other: DocHandle<any>): boolean {
    if (other === this) return false
    if (this.documentId !== other.documentId) return false
    const thisHeads = this.#effectiveFixedHeads
    const otherHeads = (other as any).#effectiveFixedHeads as
      | UrlHeads
      | undefined
    if ((thisHeads?.toString() ?? "") !== (otherHeads?.toString() ?? "")) {
      return false
    }
    const thisPath = this.path
    const otherPath = other.path
    if (thisPath.length >= otherPath.length) return false
    for (let i = 0; i < thisPath.length; i++) {
      if (!segmentEquals(thisPath[i], otherPath[i])) return false
    }
    return true
  }

  /** True if this handle is a strict descendant of `other`. */
  isChildOf(other: DocHandle<any>): boolean {
    return other.contains(this)
  }

  /**
   * True if this and `other` are both text-range handles on the same path whose ranges
   * overlap in the current document.
   */
  overlaps(other: DocHandle<any>): boolean {
    if (this.documentId !== other.documentId) return false
    if (!this.#range || !other.range) return false
    const thisPath = this.path
    const otherPath = other.path
    if (thisPath.length !== otherPath.length) return false
    for (let i = 0; i < thisPath.length; i++) {
      if (!segmentEquals(thisPath[i], otherPath[i])) return false
    }
    const thisPos = this.rangePositions()
    const otherPos = (other as DocHandle<any>).rangePositions?.()
    if (!thisPos || !otherPos) return false
    return thisPos[0] < otherPos[1] && otherPos[0] < thisPos[1]
  }

  /**
   * True if this and `other` describe the same logical location — same document, same
   * resolved path, same range, and same view.
   */
  isEquivalent(other: DocHandle<any>): boolean {
    return this.equals(other)
  }

  /**
   * Returns the handle's URL when coerced to a string (e.g. in template literals or
   * `String(handle)`). We intentionally do *not* override `valueOf`: doing so would
   * silently change `==`/`===`/`<`/`>` semantics on `DocHandle`, which is surprising
   * for an object type. Use `handle.url` or `handle.equals(other)` for comparisons.
   */
  toString(): string {
    return this.url
  }

  /**
   * Subscribe to changes that affect this handle's path. Fires when the patch affects
   * any descendant of this handle's path. Returns an unsubscribe function.
   */
  onChange(
    callback: (
      value: T | undefined,
      payload: DocHandleChangePayload<T>
    ) => void
  ): () => void {
    const listener = (payload: DocHandleChangePayload<T>) => {
      callback(this.value(), payload)
    }
    this.on("change", listener)
    return () => this.off("change", listener)
  }

  // ---------------- Internal sub-handle helpers ----------------

  /**
   * Create or retrieve a cached sub-handle at the given path inputs, relative to this handle.
   * Sub-handles are cached on the root (or view) handle so repeated calls return the same instance.
   */
  #createSubHandle(
    segments: readonly AnyPathInput[],
    options: { heads?: UrlHeads } = {}
  ): DocHandle<any> {
    // Heads source: caller override (from `view(heads)`) wins over the
    // heads inherited from `this` (set if `this` is itself view-pinned).
    const heads = options.heads ?? this.#effectiveFixedHeads

    // Identity at "no segments added, no range, no heads override" → return
    // this handle itself. Without the heads check, `root.view(h)` would
    // hit this short-circuit and return the unpinned root.
    if (segments.length === 0 && !this.#range && !heads) {
      return this
    }

    // Compose path relative to root.
    const rootHandle = this.#root ?? this
    const combined: AnyPathInput[] = this.#range
      ? [...inputsFromPath(this.#path), this.#range, ...segments]
      : [...inputsFromPath(this.#path), ...segments]

    // Cache by (path, heads). Refs sharing both → same handle instance.
    const cacheKey = handleCacheKey(combined, heads)
    const existing = this.documentState.handleCache.get(cacheKey)?.deref()
    if (existing) return existing

    const newHandle = new DocHandle<any>(rootHandle.documentId, {
      root: rootHandle,
      pathInputs: combined,
      heads,
    } as DocHandleOptions<any>)
    this.documentState.handleCache.set(cacheKey, new WeakRef(newHandle))
    return newHandle
  }

  /**
   * Normalize a mix of path inputs into ({@link PathSegment}[], {@link CursorRange}?).
   * Attempts to resolve segments (key/index/pattern) against the current document so that
   * patterns are rewritten into stable index lookups for tracking.
   */
  #normalizePath(
    rootDoc: A.Doc<any> | undefined,
    inputs: AnyPathInput[]
  ): { path: PathSegment[]; range?: CursorRange } {
    const path: PathSegment[] = []
    let range: CursorRange | undefined
    let cursor: unknown = rootDoc

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]

      if (isCursorMarker(input)) {
        if (i !== inputs.length - 1) {
          throw new Error("cursor() must be the last segment")
        }
        if (typeof cursor !== "string") {
          throw new Error("cursor() can only be used on string values")
        }
        if (rootDoc) {
          const propPath = getPropPathFromSegments(path)
          if (propPath) {
            const startCursor = A.getCursor(rootDoc, propPath, input.start)
            const endCursor = A.getCursor(rootDoc, propPath, input.end)
            range = {
              [KIND]: "cursors",
              start: startCursor,
              end: endCursor,
            }
          }
        }
        break
      }

      if (isSegment(input)) {
        // If this is a cursor-range segment (from URL parsing), treat it as a range.
        if ((input as any)[KIND] === "cursors") {
          if (i !== inputs.length - 1) {
            throw new Error("cursor range must be the last path segment")
          }
          range = input as CursorRange
          break
        }
        const resolvedProp = resolveSegmentProp(cursor, input as PathSegment)
        const segment = { ...input, prop: resolvedProp } as PathSegment
        path.push(segment)
        cursor = resolveSegment(cursor, segment)
        continue
      }

      if (typeof input === "string") {
        path.push({ [KIND]: "key", key: input, prop: input })
        cursor = resolveSegment(cursor, path[path.length - 1])
        continue
      }

      if (typeof input === "number") {
        path.push({ [KIND]: "index", index: input, prop: input })
        cursor = resolveSegment(cursor, path[path.length - 1])
        continue
      }

      if (isPattern(input)) {
        const idx = Array.isArray(cursor)
          ? (cursor as unknown[]).findIndex(item =>
              matchesPattern(item, input as Pattern)
            )
          : -1
        path.push({
          [KIND]: "match",
          match: input as Pattern,
          prop: idx >= 0 ? idx : undefined,
        } as PathSegment)
        cursor = idx >= 0 ? (cursor as unknown[])[idx] : undefined
        continue
      }

      throw new Error(`Unsupported path input: ${String(input)}`)
    }

    return { path, range }
  }

  /** The resolved numeric/string prop path for use with Automerge APIs. */
  #getPropPath(): Prop[] | undefined {
    return getPropPathFromSegments(this.#path)
  }

  /** Get the current scoped value (value at #path, or substring for a range handle). */
  #scopedValue(rootView: A.Doc<any>): unknown {
    return scopedValueOp(
      rootView,
      this.#path,
      this.#range,
      () => this.rangePositions()
    )
  }

  /** Apply a scoped change callback to a mutable view of the document. */
  #applyScopedChange(doc: A.Doc<any>, fn: RefChangeFn<any>): A.Doc<any> {
    return applyScopedChangeOp(
      doc,
      this.#path,
      this.#range,
      () => this.rangePositions(),
      fn
    )
  }

  /** Remove the value at this handle's path from the mutable document proxy. */
  #applyScopedRemove(doc: A.Doc<any>): A.Doc<any> {
    return applyScopedRemoveOp(
      doc,
      this.#path,
      this.#range,
      () => this.rangePositions()
    )
  }

  // ---------------- Listener retention (sub-handles only) ----------------
  //
  // Sub-handles live in `DocumentState.handleCache` as `WeakRef`s, so a
  // sub with no other strong references is eligible for GC. To prevent
  // listeners from being silently dropped when a caller does
  // `handle.ref(...).on("change", cb)` without holding the sub, the
  // registry keeps a strong reference to any sub with at least one
  // listener attached and drops it when the last listener is removed.
  //
  // The override pattern below (every EventEmitter listener-mutating
  // method calls `#syncRetention` after `super`) keeps the registry's
  // strong-ref set in sync. `emit` is overridden too so `once` handlers,
  // which auto-remove during emit, get accounted for without an
  // explicit `off()`.

  /**
   * Re-check whether we currently have listeners and update the registry
   * accordingly. Returns `this` so listener-mutating overrides can tail-
   * call it. No-op on root handles (only sub-handles get retained).
   */
  #syncRetention(): this {
    if (this.#root) {
      const registry = this.documentState.registry
      if (this.eventNames().length > 0) registry.insert(this)
      else registry.remove(this)
    }
    return this
  }

  on<E extends EventEmitter.EventNames<DocHandleEvents<T>>>(
    event: E,
    fn: EventEmitter.EventListener<DocHandleEvents<T>, E>,
    context?: any
  ): this {
    super.on(event, fn, context)
    return this.#syncRetention()
  }

  addListener<E extends EventEmitter.EventNames<DocHandleEvents<T>>>(
    event: E,
    fn: EventEmitter.EventListener<DocHandleEvents<T>, E>,
    context?: any
  ): this {
    super.addListener(event, fn, context)
    return this.#syncRetention()
  }

  once<E extends EventEmitter.EventNames<DocHandleEvents<T>>>(
    event: E,
    fn: EventEmitter.EventListener<DocHandleEvents<T>, E>,
    context?: any
  ): this {
    super.once(event, fn, context)
    return this.#syncRetention()
  }

  off<E extends EventEmitter.EventNames<DocHandleEvents<T>>>(
    event: E,
    fn?: EventEmitter.EventListener<DocHandleEvents<T>, E>,
    context?: any,
    once?: boolean
  ): this {
    super.off(event, fn, context, once)
    return this.#syncRetention()
  }

  removeListener<E extends EventEmitter.EventNames<DocHandleEvents<T>>>(
    event: E,
    fn?: EventEmitter.EventListener<DocHandleEvents<T>, E>,
    context?: any,
    once?: boolean
  ): this {
    super.removeListener(event, fn, context, once)
    return this.#syncRetention()
  }

  removeAllListeners(
    event?: EventEmitter.EventNames<DocHandleEvents<T>>
  ): this {
    super.removeAllListeners(event)
    return this.#syncRetention()
  }

  emit<E extends EventEmitter.EventNames<DocHandleEvents<T>>>(
    event: E,
    ...args: EventEmitter.EventArgs<DocHandleEvents<T>, E>
  ): boolean {
    // `once` listeners auto-remove themselves during emit; re-check so the
    // root can release its strong grip if that was our last listener.
    const result = super.emit(event, ...args)
    this.#syncRetention()
    return result
  }

  // ---------------- Internal accessors (registry / tests) -----------------

  /** @internal Number of strongly-retained sub-handles. Used by tests. */
  get _subHandleRetainerSize(): number {
    return this.documentState.subHandleRetainers.size
  }

  /** @internal Symbolic path of this sub-handle. Empty on root handles. */
  get _pathSegments(): readonly PathSegment[] {
    return this.#path
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Render a path-input segment to a canonical cache-key fragment.
 *
 * Path inputs come in two equivalent forms: primitives (`"foo"`, `3`,
 * `{id: "x"}` from user calls) and normalised `PathSegment` objects
 * (`{KIND: "key", ...}` from `#normalizePath`, threaded back through
 * `inputsFromPath` on chained `ref()` calls). Both forms collapse to the
 * same key here so `root.ref("x", "y")` and `root.ref("x").ref("y")`
 * cache to the same entry.
 */
function pathToCacheKey(segments: readonly AnyPathInput[]): string {
  return segments
    .map(seg => {
      if (typeof seg === "string") return `s:${seg}`
      if (typeof seg === "number") return `n:${seg}`
      if (typeof seg === "object" && seg !== null) {
        if (isSegment(seg)) {
          const kind = (seg as any)[KIND]
          if (kind === "key") return `s:${(seg as any).key}`
          if (kind === "index") return `n:${(seg as any).index}`
          if (kind === "match") {
            return `m:${JSON.stringify((seg as any).match)}`
          }
          return `seg:${JSON.stringify(seg)}`
        }
        // Plain object: a Pattern that hasn't been wrapped into a Segment yet.
        return `m:${JSON.stringify(seg)}`
      }
      return `?:${String(seg)}`
    })
    .join("/")
}

/**
 * Cache key for {@link DocumentState.handleCache}, keyed by `(path, heads)`.
 * Every distinct view of the document - sub at path, sub pinned to heads,
 * root pinned to heads - gets its own slot.
 *
 *   root.view(h)            → "#h0,h1"
 *   root.ref("x")           → "s:x"
 *   root.ref("x").view(h)   → "s:x#h0,h1"
 *   root.view(h).ref("x")   → "s:x#h0,h1"   (same as above; identity holds)
 */
function handleCacheKey(
  segments: readonly AnyPathInput[],
  heads: UrlHeads | undefined
): string {
  const pathKey = pathToCacheKey(segments)
  if (!heads || heads.length === 0) return pathKey
  return `${pathKey}#${heads.join(",")}`
}

function inputsFromPath(path: readonly PathSegment[]): AnyPathInput[] {
  return path.map(s => s as AnyPathInput)
}

function segmentEquals(a: PathSegment, b: PathSegment): boolean {
  return (a as any).prop === (b as any).prop
}

function resolveSegment(cursor: unknown, segment: PathSegment): unknown {
  if (cursor == null) return undefined
  const prop = (segment as any).prop
  if (prop === undefined) return undefined
  return (cursor as any)[prop]
}

function pathsOverlap(a: readonly Prop[], b: readonly Prop[]): boolean {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

//  TYPES

/** @hidden */
export type DocHandleOptions<T> =
  // NEW DOCUMENTS
  | {
      /** If we know this is a new document (because we're creating it) this should be set to true. */
      isNew: true

      /** The initial value of the document. */
      initialValue?: T
    }
  // EXISTING DOCUMENTS
  | {
      isNew?: false

      // An optional point in time to lock the document to.
      heads?: UrlHeads

      /** The number of milliseconds before we mark this document as unavailable if we don't have it and nobody shares it with us. */
      timeoutDelay?: number

      /** @hidden — internal: when set, constructs this handle as a sub-handle of `root`. */
      root?: DocHandle<any>

      /** @hidden — internal: path inputs for the sub-handle. */
      pathInputs?: AnyPathInput[]
    }

// EXTERNAL EVENTS

/** These are the events that this DocHandle emits to external listeners */
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

/** Emitted when this document's heads have changed */
export interface DocHandleEncodedChangePayload<T> {
  handle: DocHandle<T>
  /**
   * The full root Automerge document after the change.
   *
   * Note: even on sub-handles (`DocHandle<SubT>` where `SubT` is the scoped
   * value type) this is the whole root document, not the scoped value. The
   * type is `A.Doc<any>` rather than `A.Doc<T>` so we don't lie about that
   * on sub-handles; if you want the scoped value, use `handle.value()`.
   */
  doc: A.Doc<any>
}

/** Emitted when this document has changed */
export interface DocHandleChangePayload<T> {
  /** The handle that changed. For sub-handles, this is the sub-handle itself. */
  handle: DocHandle<T>
  /**
   * The full root Automerge document after the change.
   *
   * Note: even on sub-handles (`DocHandle<SubT>` where `SubT` is the scoped
   * value type) this is the whole root document, not the scoped value — use
   * `handle.value()` (or the first argument to `handle.onChange`) for the
   * scoped value.
   */
  doc: A.Doc<any>
  /**
   * The patches representing the change that occurred. On sub-handles, these
   * are filtered to patches whose path overlaps the sub-handle's path.
   */
  patches: A.Patch[]
  /**
   * Information about the change, carrying `before`/`after` snapshots of the
   * whole root document.
   */
  patchInfo: A.PatchInfo<any>
}

/** Emitted when this document is deleted */
export interface DocHandleDeletePayload<T> {
  handle: DocHandle<T>
}

/** Emitted when this document has been marked unavailable */
export interface DocHandleUnavailablePayload<T> {
  handle: DocHandle<T>
}

/** Emitted when an ephemeral message is received for the document */
export interface DocHandleEphemeralMessagePayload<T> {
  handle: DocHandle<T>
  senderId: PeerId
  message: unknown
}

/** Emitted when an ephemeral message is sent for this document */
export interface DocHandleOutboundEphemeralMessagePayload<T> {
  handle: DocHandle<T>
  data: Uint8Array
}

/** Emitted when we have new remote heads for this document */
export interface DocHandleRemoteHeadsPayload {
  storageId: StorageId
  heads: UrlHeads
  timestamp: number
}

