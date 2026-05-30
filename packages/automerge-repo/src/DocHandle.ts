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
import {
  isCursorMarker,
  isPattern,
  isSegment,
} from "./subdoc-handles/guards.js"
import { matchesPattern } from "./subdoc-handles/utils.js"
import {
  applyScopedChange,
  applyScopedRemove,
  rebasePatchesToScope,
  resolvePropPath,
  resolveSegmentProp,
  scopedValue,
} from "./subdoc-handles/path-ops.js"
import type {
  AnyPathInput,
  CursorRange,
  InferSubType,
  PathInput,
  PathSegment,
  Pattern,
  SubChangeFn,
  ResolvedPathSegment,
  Segment,
} from "./subdoc-handles/types.js"
import { KIND } from "./subdoc-handles/types.js"
import { foreverPromise } from "./helpers/foreverPromise.js"

/**
 * A DocHandle is a wrapper around an Automerge document. It allows you
 * to read and change the document, as well as to subscribe to changes.
 *
 * DocHandles are created by the Repo class, generally through repo.find() or repo.create().
 *
 * A simple DocHandle is defined by a URL with only a documentId, but
 * it is also possible (via the URL) to specify a specific version via "heads",
 * or to scope the handle to a subtree of the full document with a path.
 *
 * Conceptually a handle is just `(document, path, range?, heads?)`:
 * - A **root** handle has no path, range, or heads - it points at the
 *   whole live document. `Repo` only ever hands out root handles.
 * - A **sub-handle** (from {@link DocHandle.sub}) has a non-empty path
 *   into the document; reads / writes / change events are scoped to that
 *   subtree.
 * - A **view-pinned** handle (from {@link DocHandle.view}) has fixed
 *   heads; it reads at that point in time and rejects mutations.
 * - A **range** handle covers a span of text inside a string-valued
 *   sub-handle.
 *
 * Handle identity is canonicalised by the per-document registry, so any
 * two calls that name the same `(path, range, heads)` triple - even via
 * different traversals - return the same `DocHandle` instance.
 *
 * To modify the underlying document use either {@link DocHandle.change} or
 * {@link DocHandle.changeAt}. These methods will notify the `Repo` that some change has occured and
 * the `Repo` handles persisting to your local storage as well as propagating
 * changes to connected peers.
 */
export class DocHandle<T> {
  /** If set, this handle will only show the document at these heads */
  #fixedHeads?: UrlHeads

  /** Shared per-document state. Every handle into the same doc shares one. */
  readonly #document: Document<T>

  /** Symbolic path. Empty on root handles; pattern segments resolved via the registry. */
  #path: PathSegment[] = []

  /** Cursor range for text-range sub-handles. */
  #range?: CursorRange

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

    // Register in the per-document trie so dispatch can find us.
    const node = this.#document.registry.getOrCreateNode(this.#path)
    this.#document.registry.cacheHandle(
      node,
      this.#range,
      this.#fixedHeads,
      this
    )
  }

  /**
   * This handle's URL.
   * The URL might include a path, or heads, both optionally.
   * like this: `automerge:<docId>[/path][#heads]`;
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
   * @returns true if the document has not been deleted.
   * Repo only hands out handles that already have data, so this is `true`
   * from construction unless `delete()` is called.
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
   * @deprecated Always returns false - `find()` rejects on unavailable docs
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
    return foreverPromise
  }

  /**
   * The document (or subtree of one) that this handle is pointing at.
   * @returns the current Automerge.Doc value
   * @throws on deleted documents
   * @remarks In past releases, this was asynchronous and could be undefined.
   */
  doc(): A.Doc<T> | undefined {
    return this.#scopedValue(this.#document.viewAt(this.#fixedHeads)) as
      | A.Doc<T>
      | undefined
  }

  /**
   * The whole underlying document (ignoring this handle's path/range), at
   * this handle's fixed heads if it is view-pinned.
   */
  fullDoc(): A.Doc<T> {
    return this.#document.viewAt(this.#fixedHeads) as A.Doc<T>
  }

  /**
   * Returns the current "heads" of the document, akin to a git commit.
   * This precisely defines the state of a document.
   * @returns the current document's heads
   */
  heads(): UrlHeads {
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
   * @remarks This API is currently unusably slow for subdocuments with long history. We plan to fix this during alpha.
   */
  history(): UrlHeads[] {
    const topo = A.topoHistoryTraversal(this.#document.doc)

    if (this.#path.length === 0 && !this.#range) {
      return topo.map(h => encodeHeads([h])) as UrlHeads[]
    }

    // Pattern segments can resolve to different indices over history,
    // so resolve against both "before" and "after" snapshots to catch
    // patches that create or destroy the target.
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
          (beforePath !== undefined &&
            isPathPrefixCompatible(p.path, beforePath)) ||
          (afterPath !== undefined && isPathPrefixCompatible(p.path, afterPath))
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

    // Sub-handle: filter to patches overlapping the path, resolved against
    // both endpoints so create-and-destroy patches are caught either way,
    // then re-root the surviving patches relative to this handle's scope so
    // diff paths line up with `doc()` (changes at/above the scope are
    // dropped - they describe the scope's container, not its contents).
    const fromDoc = A.view(diffDoc, decodeHeads(fromHeads)) as A.Doc<any>
    const toDoc = A.view(diffDoc, decodeHeads(toHeads)) as A.Doc<any>
    const fromPath = resolvePropPath(fromDoc, this.#path)
    const toPath = resolvePropPath(toDoc, this.#path)
    if (!fromPath && !toPath) return []
    const inScope = allPatches.filter(
      p =>
        (fromPath !== undefined && isPathPrefixCompatible(p.path, fromPath)) ||
        (toPath !== undefined && isPathPrefixCompatible(p.path, toPath))
    )
    return rebasePatchesToScope(inScope, this.#path.length).patches
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
      A.inspectChange(
        this.#document.doc,
        decodeHeads([change] as UrlHeads)[0]
      ) || undefined
    )
  }

  /**
   * `update` is called any time we have a new document state; could be
   * from a local change, a remote change, or a new document from storage.
   * @throws if a handle has fixed heads
   * @hidden
   */
  update(callback: (doc: A.Doc<T>) => A.Doc<T>) {
    this.#throwIfFixedHeads("update")
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
   * On sub-handles a non-function `callback` is shorthand for "replace
   * the value at this path" (e.g. `counterSub.change(42)`). Function-typed
   * values can't use this shorthand - wrap them in `() => yourFunction`.
   *
   * A function callback's return value is ignored (the document is mutated in
   * place), consistent with root and sub-handles alike - so an accidental
   * arrow-expression return won't replace a scoped object. Use the shorthand
   * form to intentionally overwrite a slot.
   *
   * @param callback - A function that takes the current document and mutates it.
   *
   */
  change(
    callbackOrValue: A.ChangeFn<T> | SubChangeFn<T> | T,
    options: A.ChangeOptions<T> = {}
  ) {
    this.#throwIfFixedHeads("change")
    if (this.#path.length === 0 && !this.#range) {
      this.#document.applyMutation(doc =>
        A.change(doc as A.Doc<T>, options, callbackOrValue as A.ChangeFn<T>)
      )
      return
    }
    this.#document.applyMutation(doc =>
      A.change(doc as A.Doc<T>, options, mutable => {
        this.#applyScopedChange(mutable as A.Doc<any>, callbackOrValue)
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
        : ((d => {
            this.#applyScopedChange(d as A.Doc<any>, callback as SubChangeFn<T>)
          }) as A.ChangeFn<T>)

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
    this.update(doc => A.merge(doc, otherHandle.fullDoc()))
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

  /**
   * Marks the document deleted and fans `delete` out to every retained
   * handle (root and subs alike). Calling on a sub-handle deletes the
   * *whole document*; use {@link DocHandle.remove} to remove a subtree.
   * Prefer {@link Repo.delete} from user code.
   */
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
   * const titleSub = handle.sub('todos', 0, 'title');
   * titleSub.doc(); // string | undefined
   *
   * const sameSub = handle.sub('todos', 0, 'title');
   * titleSub === sameSub; // true
   * ```
   */
  sub<TPath extends readonly PathInput[]>(
    ...segments: [...TPath]
  ): DocHandle<InferSubType<T, TPath>> {
    return this.#createSubHandle(segments) as DocHandle<InferSubType<T, TPath>>
  }

  // Path / range introspection

  /**
   * Snapshot of this handle's segments with their currently-resolved
   * `prop` values (key string / literal index / matched index). Fresh
   * per call; empty on the root.
   */
  get path(): ResolvedPathSegment[] {
    if (this.#path.length === 0) return []
    // Routes through the registry's resolver so pattern caching is shared
    // with reads/writes. Unresolved trailing segments carry `prop: undefined`.
    const resolved = this.#document.registry.resolvePropPath(
      this.#path,
      this.fullDoc(),
      this.#fixedHeads
    )
    return zipResolvedSegments(this.#path, resolved)
  }

  /** The cursor range for this handle, if any. */
  get range(): CursorRange | undefined {
    return this.#range
  }

  /**
   * Returns `[startIndex, endIndex]` for this handle's cursor range,
   * resolved against the handle's own view of the document, or
   * `undefined` if this handle has no range.
   */
  rangePositions(): [number, number] | undefined {
    // Cursor positions resolve against the whole document at this handle's
    // heads (fullDoc) - for a view-pinned handle the live doc has shifted, so
    // resolving against live text would return the wrong substring.
    return this.#rangePositions(this.fullDoc(), this.#getPropPath())
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
    if (!sameFixedHeads(this.#fixedHeads, other.#fixedHeads)) return false
    const thisPath = this.#path
    const otherPath = other.#path
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
    const otherPath = other.#path
    if (thisPath.length !== otherPath.length) return false
    for (let i = 0; i < thisPath.length; i++) {
      if (!segmentEquals(thisPath[i], otherPath[i])) return false
    }
    const thisPos = this.rangePositions()
    const otherPos = other.rangePositions?.()
    if (!thisPos || !otherPos) return false
    return thisPos[0] < otherPos[1] && otherPos[0] < thisPos[1]
  }

  // Internal sub-handle helpers

  /**
   * Get-or-create a sub-/view-handle at `segments` relative to this handle.
   * Identity is canonicalised by the registry trie - each `(path, range, heads)`
   * triple returns the same DocHandle instance.
   */
  #createSubHandle(
    segments: readonly AnyPathInput[],
    options: { heads?: UrlHeads } = {}
  ): DocHandle<any> {
    const heads = options.heads ?? this.#fixedHeads

    // `root.view(h)` must not short-circuit to the unpinned root.
    if (segments.length === 0 && !this.#range && !heads) {
      return this
    }

    // `PathSegment`s are valid `AnyPathInput`s; pass through unchanged.
    const combined: AnyPathInput[] = this.#range
      ? [...this.#path, this.#range, ...segments]
      : [...this.#path, ...segments]

    // Normalize against the *whole* document at this handle's view (its
    // fixed heads, if pinned) - `#normalizePath` walks the full path from
    // the document root, and pinning ensures cursors on a pinned view
    // (`handle.view(oldHeads).sub("text", cursor(...))`) are created from -
    // and read back against - the same historical text. (Not `doc()`, which
    // is scoped to this handle's path.)
    const { path, range } = this.#normalizePath(this.fullDoc(), combined)

    const registry = this.#document.registry
    const node = registry.getOrCreateNode(path)
    const cached = registry.cachedHandle(node, range, heads)
    if (cached) return cached

    return new DocHandle<unknown>(this.#document, {
      isNew: false,
      pathSegments: path,
      range,
      heads,
    })
  }

  /**
   * Normalize mixed path inputs into `(PathSegment[], CursorRange?)`.
   * Cursor markers stabilise into a `CursorRange` against `rootDoc`.
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
        if (input === "") throw new EmptyKeyError()
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
   * Resolve the symbolic path to a concrete prop path.
   *
   * When `doc` is omitted, resolve against this handle's current view
   * ({@link doc}) using the registry's heads-keyed cache (O(depth) warm).
   *
   * When `doc` is provided - e.g. the mutable proxy inside a `change` /
   * `changeAt` block, which may be pinned to historical heads - resolve
   * freshly against *that* doc. The registry cache is keyed to the live
   * document's heads, so it must not be consulted for an arbitrary doc.
   */
  #getPropPath(doc?: A.Doc<any>): Prop[] | undefined {
    if (this.#path.length === 0) return []
    if (doc !== undefined) {
      return resolvePropPath(doc, this.#path)
    }
    return this.#document.registry.resolvePropPath(
      this.#path,
      this.fullDoc(),
      this.#fixedHeads
    )
  }

  /**
   * Resolve this handle's cursor range to `[start, end]` against an
   * explicit `doc` and its already-resolved `propPath`. The doc-threading
   * variant of the public {@link rangePositions}; used by the scoped
   * read/change/remove helpers so they resolve against the doc they
   * operate on (e.g. a historical change proxy) rather than the live one.
   */
  #rangePositions(
    doc: A.Doc<any>,
    propPath: Prop[] | undefined
  ): [number, number] | undefined {
    if (!this.#range || !propPath) return undefined
    try {
      const start = A.getCursorPosition(
        doc,
        propPath,
        this.#range.start as A.Cursor
      )
      const end = A.getCursorPosition(
        doc,
        propPath,
        this.#range.end as A.Cursor
      )
      return [start, end]
    } catch {
      return undefined
    }
  }

  /**
   * Read the value at this handle's scope (path / range). `rootView` is
   * always this handle's own view ({@link doc}), so resolution uses the
   * registry's cache.
   */
  #scopedValue(rootView: A.Doc<any>): unknown {
    const propPath = this.#getPropPath()
    return scopedValue(rootView, propPath, this.#range, () =>
      this.#rangePositions(rootView, propPath)
    )
  }

  /** Apply a scoped change to a mutable view: a mutator fn or a value. */
  #applyScopedChange(
    doc: A.Doc<any>,
    fn: SubChangeFn<any> | unknown
  ): A.Doc<any> {
    const propPath = this.#getPropPath(doc)
    this.#assertResolved(propPath, "change")
    return applyScopedChange(
      doc,
      propPath,
      this.#range,
      () => this.#rangePositions(doc, propPath),
      fn
    )
  }

  /** Remove the value at this handle's scope. */
  #applyScopedRemove(doc: A.Doc<any>): A.Doc<any> {
    const propPath = this.#getPropPath(doc)
    this.#assertResolved(propPath, "remove")
    return applyScopedRemove(doc, propPath, this.#range, () =>
      this.#rangePositions(doc, propPath)
    )
  }

  /**
   * Guard for write operations: a `propPath` of `undefined` means a
   * pattern segment matched nothing, so there's no slot to write. Reads
   * tolerate this (they return `undefined`), but a silent no-op on a
   * write is a footgun - throw instead. Note that *absent* literal keys
   * still resolve (they're symbolic), so writes can create new keys.
   */
  #assertResolved(
    propPath: Prop[] | undefined,
    operation: string
  ): asserts propPath is Prop[] {
    if (propPath === undefined) {
      throw new Error(
        `Cannot ${operation} ${this.url}: its path does not resolve in the current document (a pattern segment matched no item).`
      )
    }
  }

  // Event subscription. DocHandle doesn't extend EventEmitter; listeners
  // live in the registry, keyed by handle. The Map there holds handles
  // strongly, so any handle with a listener is naturally retained.

  on<E extends keyof DocHandleEvents<T>>(
    event: E,
    fn: DocHandleEvents<T>[E]
  ): this {
    this.#document.registry.addListener(this, event as string, fn as any)
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
    else reg.removeListener(this, event as string, fn as any)
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
    return this.#document.registry.eventNamesFor(
      this
    ) as (keyof DocHandleEvents<T>)[]
  }

  /**
   * Emit an event on this handle. Routed through the registry's
   * listener storage. Fires *only* this handle's listeners; use
   * `delete()` to fan out the document-level lifecycle events.
   */
  emit<E extends keyof DocHandleEvents<T>>(
    event: E,
    payload: Parameters<DocHandleEvents<T>[E] & ((p: any) => any)>[0]
  ): boolean {
    return this.#document.registry.emit(this, event as string, payload)
  }

  // Internal accessors (registry / tests)

  /** @internal Number of handles with at least one listener attached. */
  get _handleRetainerSize(): number {
    return this.#document.registry.retainedCount
  }

  /** @internal Number of nodes in the per-document handle trie. For tests. */
  get _trieNodeCount(): number {
    return this.#document.registry.nodeCount
  }

  /** @internal Used by `DocSynchronizer` to deliver inbound ephemerals. */
  _receiveInboundEphemeral(senderId: PeerId, message: unknown): void {
    this.#document.registry.dispatchEphemeral(senderId, message)
  }
}

// Module-private helpers

/**
 * Thrown when a path is built with an empty-string key. Empty keys don't
 * round-trip through URLs (`automerge:docId/` parses as no path), so we
 * reject them at construction rather than silently dropping them later.
 */
class EmptyKeyError extends Error {
  constructor() {
    super(
      "Empty-string keys are not supported in sub-handle paths: they do not round-trip through URLs."
    )
    this.name = "EmptyKeyError"
  }
}

/** Strip non-symbolic fields (e.g. legacy `prop`) from an incoming segment. */
function symbolicOnly(seg: PathSegment): PathSegment {
  switch (seg[KIND]) {
    case "key":
      if (seg.key === "") throw new EmptyKeyError()
      return { [KIND]: "key", key: seg.key }
    case "index":
      return { [KIND]: "index", index: seg.index }
    case "match":
      return { [KIND]: "match", match: seg.match }
  }
}

/**
 * Build the `ResolvedPathSegment[]` snapshot for `DocHandle.path` by zipping
 * symbolic segments with resolved props. Trailing segments after a failed
 * pattern carry `prop: undefined`.
 */
function zipResolvedSegments(
  symbolic: readonly PathSegment[],
  resolved: Prop[] | undefined
): ResolvedPathSegment[] {
  const out: ResolvedPathSegment[] = []
  const n = resolved?.length ?? 0
  for (let i = 0; i < symbolic.length; i++) {
    const seg = symbolic[i]
    const prop = i < n ? (resolved as Prop[])[i] : undefined
    switch (seg[KIND]) {
      case "key":
        out.push({ [KIND]: "key", key: seg.key, prop: seg.key })
        break
      case "index":
        out.push({ [KIND]: "index", index: seg.index, prop: seg.index })
        break
      case "match":
        out.push({
          [KIND]: "match",
          match: seg.match,
          prop: prop as number | undefined,
        })
        break
    }
  }
  return out
}

/** True iff two `#fixedHeads` arrays describe the same view. */
function sameFixedHeads(
  a: UrlHeads | undefined,
  b: UrlHeads | undefined
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** True iff one path prefixes the other (or they're equal). */
function isPathPrefixCompatible(
  a: readonly Prop[],
  b: readonly Prop[]
): boolean {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Structural equality for symbolic segments. */
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

      /** @hidden Pre-normalized symbolic path; set by `#createSubHandle`. */
      pathSegments?: PathSegment[]

      /** @hidden Pre-normalized cursor range. */
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
  /**
   * The value after the change, scoped to this handle. For a root handle
   * this is the whole document; for a sub-handle it is the value at the
   * handle's path (i.e. equal to `handle.doc()`). `undefined` when the
   * change removed the handle's scope.
   */
  doc: A.Doc<T> | undefined
  /**
   * The patches representing the change, with paths **relative to this
   * handle's scope**. For a root handle these are whole-document paths; for
   * a sub-handle they are re-rooted at the handle's path.
   */
  patches: A.Patch[]
  /**
   * `true` when the change replaced or removed this handle's scope wholesale
   * (a change at or above the scope boundary). Fine-grained consumers should
   * reconcile from `doc` rather than apply `patches` in this case. Always
   * `false` for a root handle.
   */
  scopeReplaced: boolean
  /**
   * Information about the change. Note: `before`/`after` here are
   * whole-document snapshots, not scoped.
   */
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
