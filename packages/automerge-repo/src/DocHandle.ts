import { next as A } from "@automerge/automerge/slim"
import type { Prop } from "@automerge/automerge/slim"
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
  applyScopedChange,
  applyScopedRemove,
  resolvePropPath,
  resolveSegmentProp,
  scopedValue,
} from "./refs/sub-handle-ops.js"
import type {
  AnyPathInput,
  CursorRange,
  InferRefType,
  PathInput,
  PathSegment,
  Pattern,
  RefChangeFn,
  ResolvedPathSegment,
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
 * tuple. The root handle allocates a `DocumentState` (the XState
 * machine, the underlying doc, sync info, and handle registry); sub- and
 * view-handles share that container, distinguishing themselves by path,
 * range, and/or fixed heads. The root handle is also the one
 * `DocumentState.rootHandle` points at - an empty-path, no-range,
 * no-heads handle. Sub-handles are scoped to a path or range, and any
 * handle can pin to fixed heads independently of the root.
 */
export class DocHandle<T> {
  /**
   * If set, this handle shows the document at these specific heads rather
   * than the latest. Stored per-handle (not on `DocumentState`) so that a
   * sub-handle can be pinned to arbitrary heads independent of the root -
   * e.g. a historical view of a sub-tree while the root tracks head.
   */
  #fixedHeads?: UrlHeads

  /**
   * Every DocHandle into a given Automerge document shares the same
   * `DocumentState`. The container owns the XState machine, the underlying
   * doc, remote sync info, and the handle registry. The root handle
   * constructs its own; sub- and view-handles receive it via options.
   * `documentState.rootHandle === this` exactly when this is the root.
   */
  readonly documentState: DocumentState

  /**
   * Symbolic path segments for sub-handles; empty array on the root
   * handle. Immutable after construction. The currently-resolved
   * concrete prop path is computed on demand via the registry, which
   * caches pattern resolutions on its trie edges.
   */
  #path: PathSegment[] = []

  /** Cursor range for text-range sub-handles. */
  #range?: CursorRange

  /** @hidden */
  constructor(
    public documentId: DocumentId,
    options: DocHandleOptions<T> = {}
  ) {
    if ("heads" in options && options.heads) {
      this.#fixedHeads = options.heads
    }

    // Sub- or view-handle: share the root's DocumentState. Path/range
    // are pre-normalized by `#createSubHandle` (which also performs
    // identity caching against the registry trie before constructing).
    // Events arrive via the registry walking the trie - no per-handle
    // subscriptions on doc state.
    if ("documentState" in options && options.documentState) {
      this.documentState = options.documentState
      this.#path = options.pathSegments ?? []
      this.#range = options.range
      return
    }

    // Root handle: allocate a `DocumentState` and register self as its
    // root. We also seed the trie root with `this` so dispatch can
    // reach us at path `[]` once we have listeners.
    this.documentState = new DocumentState(documentId, {
      timeoutDelay:
        "timeoutDelay" in options ? options.timeoutDelay : undefined,
    })
    this.documentState.rootHandle = this
    this.documentState.registry.cacheHandle(
      this.documentState.registry.root,
      undefined,
      undefined,
      this
    )

    this.begin()
  }

  // PRIVATE

  /** The current underlying root document, shared via `DocumentState`. */
  get #doc(): A.Doc<any> {
    return this.documentState.doc()
  }

  /**
   * True only on the root handle. False on sub-handles (path/range)
   * and view-handles (fixed heads).
   */
  get #isRoot(): boolean {
    return this.documentState.rootHandle === this
  }

  /**
   * Throws on non-root handles. Used by lifecycle methods that only
   * make sense on the root: sub- and view-handles don't drive the
   * document's lifecycle, the Repo does, and the Repo always holds the
   * root handle.
   */
  #requireRoot(method: string): void {
    if (!this.#isRoot) {
      throw new Error(
        `${method}() is only valid on the root document handle; use \`handle.docHandle\` to get it.`
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
      heads: this.#fixedHeads,
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
    const heads = this.#fixedHeads
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
    const heads = this.#fixedHeads
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
          : resolvePropPath(
              A.view(this.#doc, before) as A.Doc<any>,
              segments
            )
      const afterPath = resolvePropPath(
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
    const fromPath = resolvePropPath(fromDoc, this.#path)
    const toPath = resolvePropPath(toDoc, this.#path)
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
      if (!this.#isRoot) {
        throw new Error("Cannot change a Ref on a read-only handle")
      }
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }

    if (!this.#isRoot || this.#range) {
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
    if (this.#fixedHeads) {
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }

    if (!this.#isRoot || this.#range) {
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
   *          To make changes in the past, use the root document handle with no heads set.
   *
   * @returns boolean indicating whether changes are possible
   */
  isReadOnly(): boolean {
    return !!this.#fixedHeads
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
   * The root handle for this document. On the root, returns `this`;
   * on sub- and view-handles, returns the (single, shared) root they
   * were derived from. This is the "document owner": the handle the Repo
   * holds and to which lifecycle methods (`begin`, `delete`, etc.) apply.
   */
  get docHandle(): DocHandle<any> {
    return this.documentState.rootHandle
  }

  /**
   * Snapshot of this handle's path segments with currently-resolved
   * `prop` values. Each call returns a fresh snapshot built against the
   * current doc state (or this handle's fixed heads). Empty on the root.
   *
   * The internal symbolic path is immutable; the returned segments are a
   * read-time projection so observers see the resolved index a pattern
   * matches against right now (e.g. `path[1].prop` for an `{id: "x"}`
   * pattern).
   */
  get path(): ResolvedPathSegment[] {
    if (this.#path.length === 0) return []
    const doc = this.isReady() ? this.doc() : undefined
    return snapshotSegments(this.#path, doc)
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
    const heads = this.#fixedHeads
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
    this.documentState.rootHandle.change(
      ((doc: A.Doc<any>) => this.#applyScopedRemove(doc)) as A.ChangeFn<any>
    )
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
    const thisHeads = this.#fixedHeads
    const otherHeads = (other as any).#fixedHeads as
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
   * Create or retrieve a cached sub-/view-handle at the given path
   * inputs, relative to this handle. Identity is canonicalised through
   * the registry trie (or its small range-handle cache for ranges) so
   * any two calls that resolve to the same `(path, range, heads)` return
   * the same instance.
   */
  #createSubHandle(
    segments: readonly AnyPathInput[],
    options: { heads?: UrlHeads } = {}
  ): DocHandle<any> {
    // Heads source: caller override (from `view(heads)`) wins over the
    // heads inherited from `this` (set if `this` is itself view-pinned).
    const heads = options.heads ?? this.#fixedHeads

    // Identity at "no segments added, no range, no heads override" → return
    // this handle itself. Without the heads check, `root.view(h)` would
    // hit this short-circuit and return the unpinned root.
    if (segments.length === 0 && !this.#range && !heads) {
      return this
    }

    // Compose path inputs relative to the root.
    const combined: AnyPathInput[] = this.#range
      ? [...inputsFromPath(this.#path), this.#range, ...segments]
      : [...inputsFromPath(this.#path), ...segments]

    // Normalize the combined inputs into a symbolic path + optional range
    // before identity lookup. The trie is keyed by symbolic path; range
    // handles use a separate small flat cache.
    const root = this.documentState.rootHandle
    const rootDoc = root.isReady() ? root.doc() : undefined
    const { path, range } = this.#normalizePath(rootDoc, combined)

    const registry = this.documentState.registry
    const node = registry.getOrCreateNode(path)
    const cached = registry.cachedHandle(node, range, heads)
    if (cached) return cached
    const handle = new DocHandle<any>(this.documentId, {
      documentState: this.documentState,
      pathSegments: path,
      range,
      heads,
    } as DocHandleOptions<any>)
    registry.cacheHandle(node, range, heads, handle)
    return handle
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
          const propPath = resolvePropPath(rootDoc, path)
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
        // Strip any incoming `prop` field; segments are symbolic only.
        const segment = symbolicOnly(input as PathSegment)
        path.push(segment)
        const prop = resolveSegmentProp(cursor, segment)
        cursor =
          prop === undefined || cursor === null || cursor === undefined
            ? undefined
            : (cursor as any)[prop]
        continue
      }

      if (typeof input === "string") {
        path.push({ [KIND]: "key", key: input })
        cursor =
          cursor === null || cursor === undefined
            ? undefined
            : (cursor as any)[input]
        continue
      }

      if (typeof input === "number") {
        path.push({ [KIND]: "index", index: input })
        cursor =
          cursor === null || cursor === undefined
            ? undefined
            : (cursor as any)[input]
        continue
      }

      if (isPattern(input)) {
        path.push({ [KIND]: "match", match: input as Pattern })
        const idx = Array.isArray(cursor)
          ? (cursor as unknown[]).findIndex(item =>
              matchesPattern(item, input as Pattern)
            )
          : -1
        cursor = idx >= 0 ? (cursor as unknown[])[idx] : undefined
        continue
      }

      throw new Error(`Unsupported path input: ${String(input)}`)
    }

    return { path, range }
  }

  /**
   * Resolve the symbolic path to a concrete prop path against `doc`,
   * via the registry's cached pattern resolution. O(depth) when the
   * cache is warm; O(depth + |array|) per cold pattern segment.
   */
  #propPath(doc: A.Doc<any>): Prop[] | undefined {
    if (this.#path.length === 0) return []
    return this.documentState.registry.resolvePropPath(
      this.#path,
      doc,
      this.#fixedHeads
    )
  }

  /**
   * Resolve the prop path against the current live doc (no fixed
   * heads). Used by helpers like `rangePositions()` that always read
   * from this handle's own view.
   */
  #getPropPath(): Prop[] | undefined {
    if (this.#path.length === 0) return []
    return this.#propPath(this.doc())
  }

  /** Get the current scoped value (value at #path, or substring for a range handle). */
  #scopedValue(rootView: A.Doc<any>): unknown {
    return scopedValue(
      rootView,
      this.#propPath(rootView),
      this.#range,
      () => this.rangePositions()
    )
  }

  /** Apply a scoped change callback to a mutable view of the document. */
  #applyScopedChange(doc: A.Doc<any>, fn: RefChangeFn<any>): A.Doc<any> {
    return applyScopedChange(
      doc,
      this.#propPath(doc),
      this.#range,
      () => this.rangePositions(),
      fn
    )
  }

  /** Remove the value at this handle's path from the mutable document proxy. */
  #applyScopedRemove(doc: A.Doc<any>): A.Doc<any> {
    return applyScopedRemove(
      doc,
      this.#propPath(doc),
      this.#range,
      () => this.rangePositions()
    )
  }

  // ---------------- Event subscription ----------------
  //
  // DocHandle does not extend EventEmitter; listeners live in the
  // registry, keyed by handle. The Map there holds handles strongly,
  // so any handle with at least one listener is naturally retained
  // (no separate "retainer" set). Dispatch fans events out via the
  // registry's internal listener storage.

  /** Subscribe to an event on this handle. Returns `this` for chaining. */
  on<E extends keyof DocHandleEvents<T>>(
    event: E,
    fn: DocHandleEvents<T>[E]
  ): this {
    this.documentState.registry.addListener(this, event as string, fn as Function)
    return this
  }

  /** Alias for {@link on}. */
  addListener<E extends keyof DocHandleEvents<T>>(
    event: E,
    fn: DocHandleEvents<T>[E]
  ): this {
    return this.on(event, fn)
  }

  /**
   * Subscribe to the next firing of an event, then unsubscribe.
   * Wraps `fn` in a self-removing trampoline.
   */
  once<E extends keyof DocHandleEvents<T>>(
    event: E,
    fn: DocHandleEvents<T>[E]
  ): this {
    const registry = this.documentState.registry
    const wrapper = (payload: unknown) => {
      registry.removeListener(this, event as string, wrapper)
      ;(fn as any)(payload)
    }
    registry.addListener(this, event as string, wrapper)
    return this
  }

  /**
   * Unsubscribe from an event. With no `fn`, removes all listeners for
   * the given event; with no `event`, removes all listeners for this
   * handle (see {@link removeAllListeners}).
   */
  off<E extends keyof DocHandleEvents<T>>(
    event: E,
    fn?: DocHandleEvents<T>[E]
  ): this {
    const registry = this.documentState.registry
    if (fn === undefined) {
      registry.removeAllListenersForEvent(this, event as string)
    } else {
      registry.removeListener(this, event as string, fn as Function)
    }
    return this
  }

  /** Alias for {@link off}. */
  removeListener<E extends keyof DocHandleEvents<T>>(
    event: E,
    fn?: DocHandleEvents<T>[E]
  ): this {
    return this.off(event, fn)
  }

  /** Remove all listeners for an event, or for this handle entirely. */
  removeAllListeners<E extends keyof DocHandleEvents<T>>(event?: E): this {
    const registry = this.documentState.registry
    if (event === undefined) {
      registry.removeAllListenersForHandle(this)
    } else {
      registry.removeAllListenersForEvent(this, event as string)
    }
    return this
  }

  /** Number of listeners attached for the given event. */
  listenerCount<E extends keyof DocHandleEvents<T>>(event: E): number {
    return this.documentState.registry.listenerCountFor(this, event as string)
  }

  /** Snapshot of currently-registered listener functions for the given event. */
  listeners<E extends keyof DocHandleEvents<T>>(
    event: E
  ): DocHandleEvents<T>[E][] {
    return this.documentState.registry.listenersFor(
      this,
      event as string
    ) as DocHandleEvents<T>[E][]
  }

  /** Names of events with at least one listener attached. */
  eventNames(): (keyof DocHandleEvents<T>)[] {
    return this.documentState.registry.eventNamesFor(
      this
    ) as (keyof DocHandleEvents<T>)[]
  }

  /**
   * @internal Used by `DocSynchronizer` to inject inbound ephemeral
   * messages into the document's event flow. Prefer
   * `documentState.receiveEphemeral` for new code.
   */
  emit<E extends keyof DocHandleEvents<T>>(
    event: E,
    payload: Parameters<DocHandleEvents<T>[E] & ((p: any) => any)>[0]
  ): boolean {
    return this.documentState.registry.emit(this, event as string, payload)
  }

  // ---------------- Internal accessors (registry / tests) -----------------

  /** @internal Number of handles with listeners attached. Used by tests. */
  get _handleRetainerSize(): number {
    return this.documentState.registry.retainedCount
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
 * Strip any non-symbolic fields from an incoming `PathSegment` (which
 * may carry a `prop` field from older external callers or from cross-
 * module boundaries) so the segments stored on the handle remain a
 * pure symbolic description.
 */
function symbolicOnly(seg: PathSegment): PathSegment {
  switch (seg[KIND]) {
    case "key":
      return { [KIND]: "key", key: seg.key }
    case "index":
      return { [KIND]: "index", index: seg.index }
    case "match":
      return { [KIND]: "match", match: seg.match }
  }
}

/**
 * Build a `ResolvedPathSegment[]` snapshot for use in the public
 * `DocHandle.path` getter. Walks the symbolic path against `doc`,
 * resolving each segment to its current concrete prop. Pattern
 * segments resolve to the matched index in their parent array
 * (`undefined` if no match, or if a prior segment failed to resolve).
 *
 * `doc` may be undefined if the handle isn't ready yet, in which case
 * patterns can't resolve and produce `undefined` props.
 */
function snapshotSegments(
  symbolic: readonly PathSegment[],
  doc: A.Doc<any> | undefined
): ResolvedPathSegment[] {
  const out: ResolvedPathSegment[] = []
  let cursor: unknown = doc
  for (const seg of symbolic) {
    switch (seg[KIND]) {
      case "key":
        out.push({ [KIND]: "key", key: seg.key, prop: seg.key })
        cursor = step(cursor, seg.key)
        break
      case "index":
        out.push({ [KIND]: "index", index: seg.index, prop: seg.index })
        cursor = step(cursor, seg.index)
        break
      case "match": {
        const prop = resolveSegmentProp(cursor, seg) as number | undefined
        out.push({ [KIND]: "match", match: seg.match, prop })
        cursor = prop !== undefined ? step(cursor, prop) : undefined
        break
      }
    }
  }
  return out
}

function step(cursor: unknown, prop: string | number): unknown {
  if (cursor === null || cursor === undefined) return undefined
  return (cursor as any)[prop as any]
}

function inputsFromPath(path: readonly PathSegment[]): AnyPathInput[] {
  return path.map(s => s as AnyPathInput)
}

/**
 * Structural equality for symbolic segments. Two segments are equal
 * when they have the same kind and same literal/pattern data; pattern
 * segments are compared by shallow pattern equality. Used by
 * {@link DocHandle.contains} / {@link DocHandle.overlaps}.
 */
function segmentEquals(a: PathSegment, b: PathSegment): boolean {
  if (a[KIND] !== b[KIND]) return false
  switch (a[KIND]) {
    case "key":
      return a.key === (b as { key: string }).key
    case "index":
      return a.index === (b as { index: number }).index
    case "match": {
      const am = a.match
      const bm = (b as { match: Pattern }).match
      const ka = Object.keys(am)
      const kb = Object.keys(bm)
      if (ka.length !== kb.length) return false
      for (const k of ka) if (am[k] !== bm[k]) return false
      return true
    }
  }
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

      /**
       * @hidden — internal: when set, this handle is a sub- or view-handle
       * sharing the given `DocumentState` with the root handle. Omit
       * to construct a root handle (which allocates its own).
       */
      documentState?: DocumentState

      /**
       * @hidden — internal: pre-normalized symbolic path segments. Set
       * by `#createSubHandle` on construction; the constructor adopts
       * them directly without re-normalizing.
       */
      pathSegments?: PathSegment[]

      /** @hidden — internal: pre-normalized cursor range. */
      range?: CursorRange
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

