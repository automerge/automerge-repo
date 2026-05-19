import { next as A } from "@automerge/automerge/slim"
import type { Prop } from "@automerge/automerge/slim"
import {
  decodeHeads,
  encodeHeads,
  stringifyAutomergeUrl,
} from "./AutomergeUrl.js"
import { Document } from "./Document.js"
import { encode } from "./helpers/cbor.js"
import type { AutomergeUrl, DocumentId, PeerId, UrlHeads } from "./types.js"
import { StorageId } from "./storage/types.js"
import { isCursorMarker, isPattern, isSegment } from "./refs/guards.js"
import { matchesPattern } from "./refs/utils.js"
import {
  applyScopedChange,
  applyScopedRemove,
  resolvePropPath,
  resolveSegmentProp,
  scopedValue,
} from "./refs/path-ops.js"
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

/**
 * A DocHandle is a wrapper around a single Automerge document that lets us listen for changes and
 * notify the network and storage of new changes.
 *
 * @remarks
 * A `DocHandle` represents a document which is being managed by a {@link Repo}. You shouldn't ever
 * instantiate this yourself. To obtain `DocHandle` use {@link Repo.find} or {@link Repo.create}.
 *
 * To modify the underlying document use either {@link DocHandle.change} or
 * {@link DocHandle.changeAt}. These methods will notify the `Repo` that some change has occured and
 * the `Repo` will save any new changes to the attached {@link StorageAdapter} and send sync
 * messages to connected peers.
 */
export class DocHandle<T> {
  /**
   * If set, this handle reads at these specific heads rather than the
   * latest. Per-handle (not on `Document`) so a sub-handle can pin to
   * arbitrary heads independent of other handles into the same document.
   */
  #fixedHeads?: UrlHeads

  /**
   * Shared per-document state (data + registry). Every handle into the
   * same document - root, sub, view - references the same `Document`.
   */
  readonly #document: Document<T>

  /**
   * Symbolic path segments for sub-handles; empty array on root handles.
   * Immutable. The currently-resolved concrete prop path is computed on
   * demand via the registry (which caches pattern resolutions).
   */
  #path: PathSegment[] = []

  /** Cursor range for text-range sub-handles. */
  #range?: CursorRange

  /** The document this handle reads from. */
  get documentId(): DocumentId {
    return this.#document.documentId
  }

  /** @hidden */
  constructor(document: Document<T>, options: DocHandleOptions<T> = {}) {
    this.#document = document

    if ("heads" in options && options.heads) {
      this.#fixedHeads = options.heads
    }
    if ("pathSegments" in options && options.pathSegments) {
      this.#path = options.pathSegments
    }
    if ("range" in options && options.range) {
      this.#range = options.range
    }

    // Register this handle in the per-document trie so dispatch can
    // find it. Variant key is (range + fixedHeads); root + sub + view
    // all share the same registration mechanism.
    const node = this.#document.registry.getOrCreateNode(this.#path)
    this.#document.registry.cacheHandle(
      node,
      this.#range,
      this.#fixedHeads,
      this
    )
  }

  /**
   * This handle's URL. Root handles produce `automerge:<docId>[#heads]`;
   * sub-/view-handles include their path segments and any fixed heads.
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

  // TODO: remove the legacy state-machine accessors below in the next major.
  // Handles are only handed out to consumers in the `ready` state, so the
  // only meaningful transition that remains is ready → deleted.

  /**
   * @returns true if the document has not been deleted. Repo only hands out
   * handles that already have data, so this is `true` from construction
   * unless `delete()` is called.
   */
  isReady = () => !this.#document.deleted

  /**
   * @returns true if the document has been unloaded.
   */
  isUnloaded = () => false

  /**
   * @returns true if the document has been marked as deleted.
   */
  isDeleted = () => this.#document.deleted

  /**
   * @returns true if the document is currently unavailable.
   * @deprecated Always returns false — `find()` rejects on unavailable docs
   * rather than returning a handle. Will be removed in the next major.
   */
  isUnavailable = () => false

  /**
   * @returns true if the handle is in one of the given states.
   * @deprecated Will be removed in the next major.
   */
  inState = (states: HandleState[]) => states.includes(this.state)

  /** @hidden */
  get state(): HandleState {
    return this.#document.deleted ? "deleted" : "ready"
  }

  /**
   * Returns a promise that resolves when the handle is in one of the given
   * states (default `["ready"]`).
   *
   * @deprecated Handles are always ready when handed out by `Repo.find` /
   * `Repo.create`. Will be removed in the next major.
   */
  async whenReady(awaitStates: HandleState[] = ["ready"]): Promise<void> {
    if (awaitStates.includes(this.state)) return
    if (awaitStates.includes("deleted")) {
      await new Promise<void>(resolve => this.once("delete", () => resolve()))
      return
    }
    // No path to other states from a handed-out handle.
    return new Promise(() => {})
  }

  /**
   * Returns the current Automerge document this handle reads from.
   *
   * For all handles (root, sub, view) this is the *whole* underlying
   * document (at this handle's fixed heads, if any). To get the value at
   * a sub-handle's path - e.g. the items at `handle.ref("items")` - use
   * {@link value} instead.
   */
  doc(): A.Doc<T> {
    const heads = this.#fixedHeads
    const underlying = this.#document.doc
    return (heads
      ? A.view(underlying, decodeHeads(heads))
      : underlying) as A.Doc<T>
  }

  /**
   * Returns the scoped value this handle points to. For a root handle
   * this is identical to {@link doc}; for a sub-handle it returns the
   * value at the path (or the substring within a cursor range). Returns
   * `undefined` if the path doesn't resolve.
   */
  value(): T | undefined {
    const doc = this.doc()
    if (this.#path.length === 0 && !this.#range) {
      return doc as T
    }
    return this.#scopedValue(doc) as T | undefined
  }

  /**
   * @deprecated Use doc() instead.
   */
  docSync() {
    console.warn(
      "docSync is deprecated. Use doc() instead. This function will be removed as part of the 2.0 release."
    )
    return this.doc()
  }

  /**
   * Returns the current "heads" of the document, akin to a git commit.
   * For sub-handles this returns the underlying document's heads (heads
   * are a document-level concept). For view-pinned handles this returns
   * the pinned heads. To find heads where this handle's path changed,
   * use {@link history}.
   */
  heads(): UrlHeads {
    const heads = this.#fixedHeads
    if (heads) return heads
    return encodeHeads(A.getHeads(this.#document.doc))
  }

  /** @hidden */
  begin() {
    // noop - state machine removed
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
  history(): UrlHeads[] {
    const topo = A.topoHistoryTraversal(this.#document.doc)

    if (this.#path.length === 0 && !this.#range) {
      return topo.map(h => encodeHeads([h])) as UrlHeads[]
    }

    // For sub-handles the resolved prop path can change over history
    // (pattern segments match different items at different states).
    // Resolve the symbolic path against each step's snapshot - both
    // "before" and "after" - so patches that create the target
    // (resolvable only after) or destroy it (only before) are both
    // captured.
    const segments = this.#path
    const out: UrlHeads[] = []
    for (let i = 0; i < topo.length; i++) {
      const after = [topo[i]]
      const before = i === 0 ? [] : [topo[i - 1]]
      const patches = A.diff(this.#document.doc, before, after)

      const beforePath =
        before.length === 0
          ? undefined
          : resolvePropPath(
              A.view(this.#document.doc, before) as A.Doc<any>,
              segments
            )
      const afterPath = resolvePropPath(
        A.view(this.#document.doc, after) as A.Doc<any>,
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
    // A view-at-heads is the same handle pinned to `heads`. Routing
    // through `#createSubHandle` (with no path change, just heads)
    // gives stable identity via the registry trie and shares the
    // underlying Document - reads project at `heads` on demand rather
    // than cloning the doc.
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
    let fromHeads: UrlHeads
    let toHeads: UrlHeads
    let diffDoc: A.Doc<any>

    if (first instanceof DocHandle) {
      const otherHeads = first.heads()
      fromHeads = this.heads()
      toHeads = otherHeads
      if (this.documentId === first.documentId) {
        // Same document - share the doc, no clone needed.
        diffDoc = this.#document.doc
      } else {
        // Different documents: merge to verify shared history.
        diffDoc = A.merge(A.clone(this.#document.doc), first.doc()!)
      }
    } else {
      fromHeads = second ? first : this.heads()
      toHeads = second ? second : first
      diffDoc = this.#document.doc
    }

    const allPatches = A.diff(
      diffDoc,
      decodeHeads(fromHeads),
      decodeHeads(toHeads)
    )

    if (this.#path.length === 0 && !this.#range) return allPatches

    // Sub-handle: filter to patches overlapping the path, resolved
    // against both endpoint snapshots so patches that create or destroy
    // the target (present in only one endpoint) are both captured.
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
    if (!change) {
      change = this.heads()[0]
    }
    if (!change) return undefined
    // we return undefined instead of null by convention in this API
    return (
      A.inspectChange(this.#document.doc, decodeHeads([change] as UrlHeads)[0]) ||
      undefined
    )
  }

  /**
   * `update` is called any time we have a new document state; could be
   * from a local change, a remote change, or a new document from storage.
   * Routes through `Document.applyMutation` which atomically updates the
   * doc and dispatches `change` / `heads-changed` via the registry.
   * @hidden
   */
  update(callback: (doc: A.Doc<T>) => A.Doc<T>) {
    this.#document.applyMutation(callback as (doc: A.Doc<any>) => A.Doc<any>)
  }

  #throwIfFixedHeads(operation: string) {
    if (this.#fixedHeads) {
      throw new Error(
        `Cannot ${operation} on DocHandle#${this.documentId}: it is in view-only mode at specific heads.`
      )
    }
  }

  /**
   * `doneLoading` is called by the repo after it decides it has all the changes
   * it's going to get during setup. This might mean it was created locally,
   * or that it was loaded from storage, or that it was received from a peer.
   * @hidden
   */
  doneLoading() {
    // noop - state machine removed
  }

  /** Returns the latest known heads for the given peer's storageId, or
   * undefined if we have not received sync info from that peer.
   *
   * @deprecated Use {@link DocHandle.getSyncInfo} instead. Will be removed in the next major.
   */
  getRemoteHeads(storageId: StorageId): UrlHeads | undefined {
    return this.#document.syncInfoLookup?.(storageId)?.lastHeads
  }

  /** Returns the heads and the timestamp of the last update for the storageId. */
  getSyncInfo(storageId: StorageId): SyncInfo | undefined {
    return this.#document.syncInfoLookup?.(storageId)
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
    callback: A.ChangeFn<T> | RefChangeFn<T> | T,
    options: A.ChangeOptions<T> = {}
  ) {
    this.#throwIfFixedHeads("change")
    if (this.#path.length === 0 && !this.#range) {
      this.#document.applyMutation(doc =>
        A.change(doc as A.Doc<T>, options, callback as A.ChangeFn<T>)
      )
      return
    }
    // Sub-/range-handle: coerce direct value to a function, then route
    // through `applyScopedChange` (which knows how to splice text, write
    // primitives, mutate objects, etc.) inside an `A.change` block so
    // mutations land on the change proxy rather than the raw doc.
    const fn = (
      typeof callback === "function" ? callback : () => callback
    ) as RefChangeFn<T>
    this.#document.applyMutation(doc =>
      A.change(doc as A.Doc<T>, options, mutable => {
        this.#applyScopedChange(mutable as A.Doc<any>, fn)
      })
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
    this.#throwIfFixedHeads("changeAt")
    const decoded = decodeHeads(heads)
    let resultHeads: UrlHeads | undefined

    const inner: A.ChangeFn<T> =
      this.#path.length === 0 && !this.#range
        ? callback
        : (d => {
            this.#applyScopedChange(
              d as A.Doc<any>,
              callback as RefChangeFn<T>
            )
          }) as A.ChangeFn<T>

    this.#document.applyMutation(doc => {
      const result = A.changeAt(doc as A.Doc<T>, decoded, options, inner)
      resultHeads = result.newHeads ? encodeHeads(result.newHeads) : undefined
      return result.newDoc
    })
    return resultHeads
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
  isReadOnly() {
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
    this.#throwIfFixedHeads("merge")
    this.update(doc => A.merge(doc, otherHandle.doc()))
  }

  /**
   * Updates the internal state machine to mark the document unavailable.
   * @hidden
   */
  unavailable() {
    // noop - state machine removed
  }

  /**
   * Called by the repo either when the document is not found in storage.
   * @hidden
   * */
  request() {
    // noop - state machine removed
  }

  /** Called by the repo to free memory used by the document. */
  unload() {
    // noop - state machine removed
  }

  /** Called by the repo to reuse an unloaded handle. */
  reload() {
    // noop - state machine removed
  }

  /** Called by the repo when the document is deleted. */
  delete() {
    this.#document.deleted = true
    this.#document.registry.dispatchDelete()
  }

  /**
   * Sends an arbitrary ephemeral message out to all reachable peers who would receive sync messages
   * from you. It has no guarantee of delivery, and is not persisted to the underlying automerge doc
   * in any way. Messages will have a sending PeerId but this is *not* a useful user identifier (a
   * user could have multiple tabs open and would appear as multiple PeerIds). Every message source
   * must have a unique PeerId.
   */
  broadcast(message: unknown) {
    this.#document.registry.dispatchEphemeralOutbound(
      new Uint8Array(encode(message))
    )
  }

  metrics(): { numOps: number; numChanges: number } {
    return A.stats(this.#document.doc)
  }

  /** Remove the value at this sub-handle's path from the underlying document. */
  remove(): void {
    if (this.#path.length === 0 && !this.#range) {
      throw new Error("Cannot remove the root document")
    }
    this.#throwIfFixedHeads("remove")
    this.#document.applyMutation(doc =>
      A.change(doc as A.Doc<T>, mutable => {
        this.#applyScopedRemove(mutable as A.Doc<any>)
      })
    )
  }

  /**
   * Create a sub-handle scoped to a location inside this document.
   *
   * Returns the same DocHandle instance for the same path, ensuring
   * referential equality via the per-document registry trie.
   *
   * @experimental This API is experimental and may change in future versions.
   *
   * @example
   * ```ts
   * const titleRef = handle.ref('todos', 0, 'title');
   * titleRef.value(); // string | undefined
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

  // ---------------- Path / range introspection ----------------

  /**
   * The root document handle (the path-[]/no-range/no-heads handle into
   * this document). On the root, returns `this`. On sub-/view-handles,
   * returns the canonical root in the registry - the one Repo holds
   * and to which document-level lifecycle methods apply.
   */
  get docHandle(): DocHandle<any> {
    if (this.#path.length === 0 && !this.#range && !this.#fixedHeads) {
      return this
    }
    const root = this.#document.registry.cachedHandle(
      this.#document.registry.root,
      undefined,
      undefined
    )
    if (!root) {
      throw new Error(
        `No root handle registered for document ${this.documentId}`
      )
    }
    return root
  }

  /**
   * Snapshot of this handle's path segments with currently-resolved
   * `prop` values. Each call returns a fresh snapshot built against
   * the current doc state (or this handle's fixed heads). Empty on
   * the root.
   *
   * The internal symbolic path is immutable; the returned segments
   * are a read-time projection so observers see the resolved index a
   * pattern matches against right now.
   */
  get path(): ResolvedPathSegment[] {
    if (this.#path.length === 0) return []
    const doc = this.doc()
    return snapshotSegments(this.#path, doc)
  }

  /** The cursor range for this handle, if any. */
  get range(): CursorRange | undefined {
    return this.#range
  }

  /**
   * Returns `[startIndex, endIndex]` for the current cursor range,
   * resolved against the current text value, or `undefined` if this
   * handle has no range.
   */
  rangePositions(): [number, number] | undefined {
    if (!this.#range) return undefined
    const rootDoc = this.doc()
    const propPath = this.#getPropPath()
    if (!propPath) return undefined
    try {
      const start = A.getCursorPosition(
        rootDoc,
        propPath,
        this.#range.start as A.Cursor
      )
      const end = A.getCursorPosition(
        rootDoc,
        propPath,
        this.#range.end as A.Cursor
      )
      return [start, end]
    } catch {
      return undefined
    }
  }

  /** True if the other handle has the same URL as this one. */
  equals(other: DocHandle<any>): boolean {
    return this.url === other.url
  }

  /**
   * True if this handle's path is a strict ancestor of `other`'s path,
   * within the same document and view (heads).
   */
  contains(other: DocHandle<any>): boolean {
    if (other === this) return false
    if (this.documentId !== other.documentId) return false
    const thisHeads = this.#fixedHeads
    const otherHeads = (other as DocHandle<any>).#fixedHeads
    if ((thisHeads?.toString() ?? "") !== (otherHeads?.toString() ?? "")) {
      return false
    }
    const thisPath = this.#path
    const otherPath = other._pathSegments
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
   * True if this and `other` are both text-range handles on the same path
   * whose ranges overlap in the current document.
   */
  overlaps(other: DocHandle<any>): boolean {
    if (this.documentId !== other.documentId) return false
    if (!this.#range || !other.range) return false
    const thisPath = this.#path
    const otherPath = other._pathSegments
    if (thisPath.length !== otherPath.length) return false
    for (let i = 0; i < thisPath.length; i++) {
      if (!segmentEquals(thisPath[i], otherPath[i])) return false
    }
    const thisPos = this.rangePositions()
    const otherPos = other.rangePositions?.()
    if (!thisPos || !otherPos) return false
    return thisPos[0] < otherPos[1] && otherPos[0] < thisPos[1]
  }

  /**
   * Subscribe to changes affecting this handle's path; the callback
   * receives `(value, payload)`. Returns an unsubscribe function.
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
   * the registry trie (each `(path, range, heads)` returns the same
   * DocHandle instance).
   */
  #createSubHandle(
    segments: readonly AnyPathInput[],
    options: { heads?: UrlHeads } = {}
  ): DocHandle<any> {
    const heads = options.heads ?? this.#fixedHeads

    // Identity at "no segments added, no range, no heads override" →
    // return this handle itself. Without the heads check, `root.view(h)`
    // would hit this short-circuit and return the unpinned root.
    if (segments.length === 0 && !this.#range && !heads) {
      return this
    }

    // Compose path inputs relative to the root's path (which is empty).
    const combined: AnyPathInput[] = this.#range
      ? [...inputsFromPath(this.#path), this.#range, ...segments]
      : [...inputsFromPath(this.#path), ...segments]

    // Normalize combined inputs into symbolic path + optional range.
    const { path, range } = this.#normalizePath(this.#document.doc, combined)

    const registry = this.#document.registry
    const node = registry.getOrCreateNode(path)
    const cached = registry.cachedHandle(node, range, heads)
    if (cached) return cached

    // Constructor adds the new handle to the trie itself.
    return new DocHandle<unknown>(this.#document, {
      isNew: false,
      pathSegments: path,
      range,
      heads,
    })
  }

  /**
   * Normalize a mix of path inputs into `(PathSegment[], CursorRange?)`.
   * Patterns and keys/indices become symbolic segments; cursor markers
   * are stabilised into a `CursorRange` against the current document.
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
        // If this is a cursor-range segment (from URL parsing), treat as range.
        if ((input as any)[KIND] === "cursors") {
          if (i !== inputs.length - 1) {
            throw new Error("cursor range must be the last path segment")
          }
          range = input as CursorRange
          break
        }
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
   * Resolve the symbolic path to a concrete prop path against the
   * current view's doc. Uses the registry's cached pattern resolution.
   * O(depth) when warm; O(depth + |array|) per cold pattern segment.
   */
  #getPropPath(): Prop[] | undefined {
    if (this.#path.length === 0) return []
    return this.#document.registry.resolvePropPath(
      this.#path,
      this.doc(),
      this.#fixedHeads
    )
  }

  /** Read the value at this handle's scope (path / range). */
  #scopedValue(rootView: A.Doc<any>): unknown {
    return scopedValue(
      rootView,
      this.#getPropPath(),
      this.#range,
      () => this.rangePositions()
    )
  }

  /** Apply a scoped change callback to a mutable view of the document. */
  #applyScopedChange(doc: A.Doc<any>, fn: RefChangeFn<any>): A.Doc<any> {
    return applyScopedChange(
      doc,
      this.#getPropPath(),
      this.#range,
      () => this.rangePositions(),
      fn
    )
  }

  /** Remove the value at this handle's scope. */
  #applyScopedRemove(doc: A.Doc<any>): A.Doc<any> {
    return applyScopedRemove(
      doc,
      this.#getPropPath(),
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

  on<E extends keyof DocHandleEvents<T>>(
    event: E,
    fn: DocHandleEvents<T>[E]
  ): this {
    this.#document.registry.addListener(this, event as string, fn as Function)
    return this
  }

  addListener<E extends keyof DocHandleEvents<T>>(
    event: E,
    fn: DocHandleEvents<T>[E]
  ): this {
    return this.on(event, fn)
  }

  once<E extends keyof DocHandleEvents<T>>(
    event: E,
    fn: DocHandleEvents<T>[E]
  ): this {
    const reg = this.#document.registry
    const wrapper = (payload: unknown) => {
      reg.removeListener(this, event as string, wrapper)
      ;(fn as any)(payload)
    }
    reg.addListener(this, event as string, wrapper)
    return this
  }

  off<E extends keyof DocHandleEvents<T>>(
    event: E,
    fn?: DocHandleEvents<T>[E]
  ): this {
    const reg = this.#document.registry
    if (fn === undefined) reg.removeAllListenersForEvent(this, event as string)
    else reg.removeListener(this, event as string, fn as Function)
    return this
  }

  removeListener<E extends keyof DocHandleEvents<T>>(
    event: E,
    fn?: DocHandleEvents<T>[E]
  ): this {
    return this.off(event, fn)
  }

  removeAllListeners<E extends keyof DocHandleEvents<T>>(event?: E): this {
    const reg = this.#document.registry
    if (event === undefined) reg.removeAllListenersForHandle(this)
    else reg.removeAllListenersForEvent(this, event as string)
    return this
  }

  /** Number of listeners attached for the given event. */
  listenerCount<E extends keyof DocHandleEvents<T>>(event: E): number {
    return this.#document.registry.listenerCountFor(this, event as string)
  }

  /** Snapshot of currently-registered listener functions for the given event. */
  listeners<E extends keyof DocHandleEvents<T>>(
    event: E
  ): DocHandleEvents<T>[E][] {
    return this.#document.registry.listenersFor(
      this,
      event as string
    ) as DocHandleEvents<T>[E][]
  }

  /** Names of events with at least one listener attached. */
  eventNames(): (keyof DocHandleEvents<T>)[] {
    return this.#document.registry.eventNamesFor(this) as (keyof DocHandleEvents<T>)[]
  }

  /**
   * Emit an event on this handle. Routed through the registry's
   * listener storage. The `delete` event marks the document deleted as
   * a side-effect, so observers on *this* emit see `isDeleted() === true`.
   */
  emit<E extends keyof DocHandleEvents<T>>(
    event: E,
    payload: Parameters<DocHandleEvents<T>[E] & ((p: any) => any)>[0]
  ): boolean {
    if ((event as string) === "delete") this.#document.deleted = true
    return this.#document.registry.emit(this, event as string, payload)
  }

  // ---------------- Internal accessors (registry / tests) ----------------

  /** @internal Symbolic path of this handle. Empty on root handles. */
  get _pathSegments(): readonly PathSegment[] {
    return this.#path
  }

  /** @internal Number of handles with at least one listener attached. */
  get _handleRetainerSize(): number {
    return this.#document.registry.retainedCount
  }

  /**
   * @internal Used by `DocSynchronizer` to inject inbound ephemeral
   * messages. Fans out to every retained handle into this document via
   * the registry.
   */
  _receiveInboundEphemeral(senderId: PeerId, message: unknown): void {
    this.#document.registry.dispatchEphemeral(senderId, message)
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Strip any non-symbolic fields (e.g. legacy `prop`) from an incoming
 * `PathSegment`, returning a pure symbolic segment for internal storage.
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
 * Build the `ResolvedPathSegment[]` snapshot for `DocHandle.path`.
 * Walks the symbolic path against `doc` resolving each pattern segment
 * to its current matched index (or `undefined` if no match / parent
 * doesn't resolve).
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

/** True iff one path is a prefix of the other (or they're equal). */
function pathsOverlap(a: readonly Prop[], b: readonly Prop[]): boolean {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Structural equality for symbolic segments. Two segments are equal
 * when they have the same kind and same literal/pattern data.
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

//  TYPES

export type SyncInfo = {
  lastHeads: UrlHeads
  lastSyncTimestamp: number
}

/** @hidden */
export type DocHandleOptions<T> =
  | // NEW DOCUMENTS
  {
      /** If we know this is a new document (because we're creating it) this should be set to true. */
      isNew: true

      /** The initial value of the document. */
      initialValue?: T
    } // EXISTING DOCUMENTS
  | {
      isNew?: false

      // An optional point in time to lock the document to.
      heads?: UrlHeads

      /** The number of milliseconds before we mark this document as unavailable if we don't have it and nobody shares it with us. */
      timeoutDelay?: number

      /**
       * @hidden — internal: pre-normalized symbolic path segments for
       * sub-handles. Set by `#createSubHandle`; the constructor adopts
       * them as-is.
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
  doc: A.Doc<T>
}

/** Emitted when this document has changed */
export interface DocHandleChangePayload<T> {
  /** The handle that changed */
  handle: DocHandle<T>
  /** The value of the document after the change */
  doc: A.Doc<T>
  /** The patches representing the change that occurred */
  patches: A.Patch[]
  /** Information about the change */
  patchInfo: A.PatchInfo<T>
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

// STATE MACHINE TYPES & CONSTANTS

// state

/**
 * Possible internal states for a DocHandle
 */
export const HandleState = {
  /** The handle has been created but not yet loaded or requested */
  IDLE: "idle",
  /** We are waiting for storage to finish loading */
  LOADING: "loading",
  /** We are waiting for someone in the network to respond to a sync request */
  REQUESTING: "requesting",
  /** The document is available */
  READY: "ready",
  /** The document has been unloaded from the handle, to free memory usage */
  UNLOADED: "unloaded",
  /** The document has been deleted from the repo */
  DELETED: "deleted",
  /** The document was not available in storage or from any connected peers */
  UNAVAILABLE: "unavailable",
} as const
export type HandleState = (typeof HandleState)[keyof typeof HandleState]

export const {
  IDLE,
  LOADING,
  REQUESTING,
  READY,
  UNLOADED,
  DELETED,
  UNAVAILABLE,
} = HandleState
