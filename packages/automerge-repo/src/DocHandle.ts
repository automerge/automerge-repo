import { next as A } from "@automerge/automerge/slim"
import type { Prop } from "@automerge/automerge/slim"
import {
  decodeHeads,
  encodeHeads,
  stringifyAutomergeUrl,
} from "./AutomergeUrl.js"
import type { DocumentState } from "./DocumentState.js"
import { arraysAreEqual } from "./sedimentree/arraysAreEqual.js"
import type {
  AutomergeUrl,
  DocumentId,
  PeerId,
  SyncInfo,
  UrlHeads,
} from "./types.js"
import type { DocHandleEvents } from "./DocHandleEvents.js"
import type {
  ExtensionContext,
  ExtensionEvents,
  ExtensionMembers,
  HandleClass,
  HandleExtension,
} from "./sedimentree/extension.js"
import {
  isCursorMarker,
  isPattern,
  isSegment,
} from "./subdoc-handles/guards.js"
import { matchesPattern } from "./subdoc-handles/utils.js"
import {
  applyScopedChange,
  applyScopedRemove,
  cursorRangePositions,
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
import {
  EmptyKeyError,
  isPathPrefixCompatible,
  sameFixedHeads,
  segmentEquals,
  symbolicOnly,
  zipResolvedSegments,
} from "./subdoc-handles/segments.js"

/** @internal Construction options; only the Repo and sub-handles build handles. */
type DocHandleOptions = {
  heads?: UrlHeads
  pathSegments?: PathSegment[]
  range?: CursorRange
}

/** The events of a handle with the extensions `X`. */
export type HandleEvents<
  T,
  X extends HandleExtension = never,
> = DocHandleEvents<T, X> & ExtensionEvents<T, X>

/**
 * A {@link DocHandle} with the members its Repo's backend adds; see
 * {@link HandleExtension}.
 */
export type ExtendedHandle<T, X extends HandleExtension = never> = DocHandle<
  T,
  X
> &
  ExtensionMembers<T, X>

let stateOf: (handle: DocHandle<any>) => DocumentState<any>

/**
 * @internal The members DocHandle defines on each instance, not its
 * prototype. Extensions may not redefine these either.
 */
export const instanceMembers: readonly string[] = ["isReady", "isDeleted"]

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
export class DocHandle<T, in X extends HandleExtension = never> {
  static {
    stateOf = handle => handle.#state
  }

  /** If set, this handle will only show the document at these heads */
  #fixedHeads?: UrlHeads

  /** Shared per-document state. Every handle into the same doc shares one;
   * a sub-handle's `T` is its scoped value's type, not the document's. */
  readonly #state: DocumentState<any>

  /** Symbolic path. Empty on root handles; pattern segments resolved via the registry. */
  #path: PathSegment[] = []

  /** Cursor range for text-range sub-handles. */
  #range?: CursorRange

  get documentId(): DocumentId {
    return this.#state.documentId
  }

  /** @internal Handles are obtained from a {@link Repo} or another handle. */
  constructor(state: DocumentState<any>, options: DocHandleOptions = {}) {
    this.#state = state
    this.#fixedHeads = options.heads
    this.#path = options.pathSegments ?? []
    this.#range = options.range

    // Register in the per-document trie so dispatch can find us.
    const node = this.#state.registry.getOrCreateNode(this.#path)
    this.#state.registry.cacheHandle(node, this.#range, this.#fixedHeads, this)
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

  /**
   * @returns true once the first snapshot is ready, unless deleted.
   */
  isReady = () => this.#state.ready && !this.#state.deleted

  /**
   * @returns true if the document has been marked as deleted.
   */
  isDeleted = () => this.#state.deleted

  /**
   * The document (or subtree of one) that this handle is pointing at.
   * @returns the current Automerge.Doc value
   * @throws on deleted documents
   * @remarks In past releases, this was asynchronous and could be undefined.
   */
  doc(): A.Doc<T> | undefined {
    return this.#scopedValue(this.#state.viewAt(this.#fixedHeads)) as
      | A.Doc<T>
      | undefined
  }

  /**
   * The whole underlying document (ignoring this handle's path/range), at
   * this handle's fixed heads if it is view-pinned.
   */
  fullDoc(): A.Doc<T> {
    return this.#state.viewAt(this.#fixedHeads) as A.Doc<T>
  }

  /**
   * Returns the "heads" of the document, akin to a git commit.
   * This precisely defines the state of a document.
   * @returns the current document's heads (which may be fixed by .view() or equivalent)
   */
  heads(): UrlHeads {
    if (this.#fixedHeads) return this.#fixedHeads
    return encodeHeads(this.#state.heads())
  }

  /**
   * True if every hash in `heads` is in this document's history. For a
   * view-pinned handle, only history up to its fixed heads counts.
   */
  hasHeads(heads: UrlHeads): boolean {
    const decoded = decodeHeads(heads)
    const doc = this.#state.doc
    if (!A.hasHeads(doc, decoded)) return false
    if (!this.#fixedHeads) return true
    // A.hasHeads ignores a view's heads, so check ancestry of the fixed heads:
    // adding `heads` changes nothing iff they are already ancestors.
    const fixed = decodeHeads(this.#fixedHeads)
    return (
      A.getChangesMetaSince(doc, [...fixed, ...decoded]).length ===
      A.getChangesMetaSince(doc, fixed).length
    )
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
    const topo = A.topoHistoryTraversal(this.#state.doc)

    if (this.#path.length === 0 && !this.#range) {
      return topo.map(h => encodeHeads([h])) as UrlHeads[]
    }

    const doc = this.#state.doc
    const out: UrlHeads[] = []
    for (let i = 0; i < topo.length; i++) {
      const after = [topo[i]]
      const before = i === 0 ? undefined : [topo[i - 1]]
      const inScope = this.#inScope(doc, before, after)
      if (inScope && A.diff(doc, before ?? [], after).some(inScope))
        out.push(encodeHeads([topo[i]]) as UrlHeads)
    }
    return out
  }

  /**
   * Whether a patch between two snapshots touches this handle's path, or
   * undefined if the path resolves at neither. Pattern segments can resolve
   * to different indices over history, so both endpoints are checked to
   * catch patches that create or destroy the target.
   */
  #inScope(
    doc: A.Doc<any>,
    before: A.Heads | undefined,
    after: A.Heads
  ): ((patch: A.Patch) => boolean) | undefined {
    const beforePath =
      before && resolvePropPath(A.view(doc, before) as A.Doc<any>, this.#path)
    const afterPath = resolvePropPath(
      A.view(doc, after) as A.Doc<any>,
      this.#path
    )
    if (!beforePath && !afterPath) return undefined
    return patch =>
      (beforePath !== undefined &&
        isPathPrefixCompatible(patch.path, beforePath)) ||
      (afterPath !== undefined && isPathPrefixCompatible(patch.path, afterPath))
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
   * @param heads - The heads to view the document at. See history().
   * @returns DocHandle<T> at the time of `heads`
   */
  view(heads: UrlHeads): ExtendedHandle<T, X> {
    return this.#createSubHandle([], { heads }) as ExtendedHandle<T, X>
  }

  /**
   * Returns a set of Patch operations that will move a materialized document from one state to another
   * if applied.
   *
   * @remarks
   * We allow specifying either:
   * - Two sets of heads to compare directly
   * - A single set of heads to compare against our current heads
   * - Another DocHandle to compare against. A different document's whole history
   *   (whatever that handle's path) is merged into a copy of this one first, so
   *   even unrelated documents diff without error.
   *
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
        diffDoc = this.#state.doc
      } else {
        // Different documents: merge so both handles' heads are in one doc.
        diffDoc = A.merge(A.clone(this.#state.doc), first.fullDoc())
      }
    } else {
      fromHeads = second ? first : this.heads()
      toHeads = second ? second : first
      diffDoc = this.#state.doc
    }

    const allPatches = A.diff(
      diffDoc,
      decodeHeads(fromHeads),
      decodeHeads(toHeads)
    )

    if (this.#path.length === 0 && !this.#range) return allPatches

    // Sub-handle: keep patches overlapping the path, then re-root them
    // relative to this handle's scope so diff paths line up with `doc()`
    // (changes at/above the scope are dropped - they describe the scope's
    // container, not its contents).
    const inScope = this.#inScope(
      diffDoc,
      decodeHeads(fromHeads),
      decodeHeads(toHeads)
    )
    if (!inScope) return []
    return rebasePatchesToScope(allPatches.filter(inScope), this.#path.length)
      .patches
  }

  #throwIfFixedHeads(operation: string) {
    if (this.#fixedHeads) {
      throw new Error(
        `Cannot ${operation} on DocHandle#${this.documentId}: it is in view-only mode at specific heads.`
      )
    }
  }

  /** Returns the heads and the timestamp of the last update from the given peer. */
  getSyncInfo(peerId: PeerId): SyncInfo | undefined {
    return this.#state.getSyncInfo(peerId)
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
   * Mutation and events are immediate. The returned promise resolves once this
   * change and every earlier local change are recoverable; it does not wait for
   * peers or remote durability. If an earlier save fails, this rejects too, and
   * every later change rejects with that error, unapplied.
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
  ): Promise<void> {
    this.#throwIfFixedHeads("change")
    if (this.#path.length === 0 && !this.#range) {
      return this.#state.applyMutation(doc =>
        A.change(doc as A.Doc<T>, options, callbackOrValue as A.ChangeFn<T>)
      )
    }
    return this.#state.applyMutation(doc =>
      A.change(doc as A.Doc<T>, options, mutable => {
        this.#applyScopedChange(mutable as A.Doc<any>, callbackOrValue)
      })
    )
  }

  /**
   * Makes a change as if the document were at `heads`.
   *
   * Mutation and events are immediate, as with {@link DocHandle.change}.
   *
   * @returns A promise resolving, once local history is recoverable, to the
   * heads of the concurrent change that was made.
   */
  changeAt(
    heads: UrlHeads,
    callback: A.ChangeFn<T>,
    options: A.ChangeOptions<T> = {}
  ): Promise<UrlHeads | undefined> {
    this.#throwIfFixedHeads("changeAt")
    const decoded = decodeHeads(heads)
    let resultHeads: UrlHeads | undefined

    const inner: A.ChangeFn<T> =
      this.#path.length === 0 && !this.#range
        ? callback
        : ((d => {
            this.#applyScopedChange(d as A.Doc<any>, callback as SubChangeFn<T>)
          }) as A.ChangeFn<T>)

    return this.#state
      .applyMutation(doc => {
        const result = A.changeAt(doc as A.Doc<T>, decoded, options, inner)
        resultHeads = result.newHeads ? encodeHeads(result.newHeads) : undefined
        return result.newDoc
      })
      .then(() => resultHeads)
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
    // A merge can bring many boundaries at once; store their fragments with it.
    return this.#state.applyMutation(
      doc => A.merge(doc, otherHandle.fullDoc()),
      { compact: true }
    )
  }

  /**
   * Marks the document deleted and fans `delete` out to every retained
   * handle (root and subs alike). Calling on a sub-handle deletes the
   * *whole document*; use {@link DocHandle.remove} to remove a subtree.
   * Prefer {@link Repo.delete} from user code.
   */
  delete() {
    this.#state.delete()
  }

  metrics(): { numOps: number; numChanges: number } {
    return A.stats(this.#state.doc)
  }

  /** Remove the value at this sub-handle's path from the underlying document. */
  remove(): Promise<void> {
    if (this.#path.length === 0 && !this.#range) {
      throw new Error("Cannot remove the root document")
    }
    this.#throwIfFixedHeads("remove")
    return this.#state.applyMutation(doc =>
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
  ): ExtendedHandle<InferSubType<T, TPath>, X> {
    return this.#createSubHandle(segments) as ExtendedHandle<
      InferSubType<T, TPath>,
      X
    >
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
    const resolved = this.#state.registry.resolvePropPath(
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
    return arraysAreEqual(
      thisPath,
      otherPath.slice(0, thisPath.length),
      segmentEquals
    )
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
    if (!arraysAreEqual(thisPath, otherPath, segmentEquals)) return false
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
  ): DocHandle<any, any> {
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

    const registry = this.#state.registry
    const node = registry.getOrCreateNode(path)
    const cached = registry.cachedHandle(node, range, heads)
    if (cached) return cached

    return new this.#state.Handle<unknown>(this.#state, {
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
    return this.#state.registry.resolvePropPath(
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
    return cursorRangePositions(doc, propPath, this.#range)
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

  /**
   * Apply a scoped change to a mutable view: a mutator fn or a value.
   *
   * `fn` is typed `unknown` — identical to `SubChangeFn<any> | unknown`, which
   * collapses to `unknown` (a union with `unknown` is just `unknown`). A
   * function is treated as the mutator; any other value is a replacement.
   */
  #applyScopedChange(doc: A.Doc<any>, fn: unknown): A.Doc<any> {
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
  // live in the document's Listeners, keyed by handle, which holds handles
  // strongly, so any handle with a listener is naturally retained.

  on<E extends keyof HandleEvents<T, X>>(
    event: E,
    fn: HandleEvents<T, X>[E]
  ): this {
    this.#state.listeners.add(this, event as string, fn as any)
    return this
  }

  addListener<E extends keyof HandleEvents<T, X>>(
    event: E,
    fn: HandleEvents<T, X>[E]
  ): this {
    return this.on(event, fn)
  }

  once<E extends keyof HandleEvents<T, X>>(
    event: E,
    fn: HandleEvents<T, X>[E]
  ): this {
    const listeners = this.#state.listeners
    const wrapper = (payload: unknown) => {
      listeners.remove(this, event as string, wrapper)
      ;(fn as any)(payload)
    }
    listeners.add(this, event as string, wrapper)
    return this
  }

  off<E extends keyof HandleEvents<T, X>>(
    event: E,
    fn?: HandleEvents<T, X>[E]
  ): this {
    this.#state.listeners.remove(this, event as string, fn as any)
    return this
  }

  removeListener<E extends keyof HandleEvents<T, X>>(
    event: E,
    fn?: HandleEvents<T, X>[E]
  ): this {
    return this.off(event, fn)
  }

  removeAllListeners<E extends keyof HandleEvents<T, X>>(event?: E): this {
    const listeners = this.#state.listeners
    if (event === undefined) listeners.removeAll(this)
    else listeners.remove(this, event as string)
    return this
  }

  /** Number of listeners attached for the given event. */
  listenerCount<E extends keyof HandleEvents<T, X>>(event: E): number {
    return this.#state.listeners.count(this, event as string)
  }

  /** Snapshot of currently-registered listener functions for the given event. */
  listeners<E extends keyof HandleEvents<T, X>>(
    event: E
  ): HandleEvents<T, X>[E][] {
    return this.#state.listeners.listeners(
      this,
      event as string
    ) as HandleEvents<T, X>[E][]
  }

  /**
   * Names of events with at least one listener attached. Typed as this
   * handle's event names, though open to any string: a handle with more
   * events must still be usable where one with fewer is expected.
   */
  eventNames(): (keyof HandleEvents<T, X> | (string & {}))[] {
    return this.#state.listeners.eventNames(this)
  }

  /**
   * Emit an event on this handle. Fires *only* this handle's listeners; use
   * `delete()` to fan out the document-level lifecycle events.
   */
  emit<E extends keyof HandleEvents<T, X>>(
    event: E,
    payload: Parameters<HandleEvents<T, X>[E] & ((p: any) => any)>[0]
  ): boolean {
    return this.#state.listeners.emit(this, event as string, payload)
  }
}

/**
 * @internal The handle class with `extensions` applied, each a subclass of
 * the last.
 */
export function extendHandle(
  extensions: readonly HandleExtension[]
): typeof DocHandle {
  const context = (handle: DocHandle<any>): ExtensionContext =>
    stateOf(handle).extensionContext
  const kinds = new Set<string>()
  let Handle: HandleClass = DocHandle
  for (const extension of extensions) {
    const { kind } = extension
    if (kinds.has(kind)) throw new Error(`Duplicate handle extension: ${kind}`)
    kinds.add(kind)
    const base = Handle
    Handle = extension.extend(base, context)
    if (!(Handle.prototype instanceof base))
      throw new Error(`Handle extension ${kind} must subclass its base`)
    // Extensions only add: a replaced member would change the handle for
    // everyone else, and cannot be typed.
    for (
      let added = Handle.prototype;
      added !== base.prototype;
      added = Object.getPrototypeOf(added)
    )
      for (const name of Reflect.ownKeys(added)) {
        if (name === "constructor") continue
        if (name in base.prototype || instanceMembers.includes(name as string))
          throw new Error(`Handle extension ${kind} redefines ${String(name)}`)
      }
  }
  return Handle as typeof DocHandle
}
