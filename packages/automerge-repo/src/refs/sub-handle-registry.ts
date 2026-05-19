import { next as A } from "@automerge/automerge/slim"
import type { Prop } from "@automerge/automerge/slim"
import { encodeHeads } from "../AutomergeUrl.js"
import type { UrlHeads } from "../types.js"
import type { DocHandle } from "../DocHandle.js"
import type {
  DocumentChangePayload,
  DocumentEphemeralMessagePayload,
  DocumentEphemeralMessageOutboundPayload,
  DocumentHeadsChangedPayload,
  DocumentRemoteHeadsPayload,
  DocumentState,
} from "../DocumentState.js"
import { KIND } from "./types.js"
import type { CursorRange, PathSegment, Pattern } from "./types.js"
import { matchesPattern } from "./utils.js"

/**
 * Per-document trie that owns (a) handle identity, (b) pattern
 * resolution caching, (c) event dispatch, and (d) listener retention.
 *
 * Every distinct symbolic path is exactly one trie node. A node
 * carries a `liveHandle` WeakRef slot for the canonical handle at
 * that path, plus an optional sparse `viewHandles` map for view-pinned
 * variants at the same path. Pattern segments live as a flat list of
 * `PatternEdge`s on the parent node and each carries a cached
 * `(resolvedIndex, resolvedAtHeads)` pair - the *only* place pattern
 * resolutions are cached.
 *
 * Reads (`value`, `change`, `remove`) walk the symbolic path against
 * the trie. Pattern segments hit `edge.resolvedIndex` (warm) or run
 * one bulk-resolve over the parent array (cold). Either way reads are
 * O(depth) when warm.
 *
 * Change dispatch walks the trie once per patch, collecting affected
 * handles. Pattern edges encountered along a walk are bulk-resolved
 * (single array iteration, working set shrinks on match, early exit
 * when empty) so that O(N) refs sharing a pattern at the same path
 * cost no more than one ref.
 */
export class SubHandleRegistry {
  /** Trie root — represents the document at path `[]`. */
  readonly root: TrieNode = emptyNode()

  /**
   * Per-handle listener storage. Keys are handles with at least one
   * listener; this Map holds them strongly so a handle whose only
   * remaining reference is its own listener stays alive. Keyed by event
   * name → Set of callbacks.
   *
   * The Map's keys (`#listeners.keys()`) are the set of "retained"
   * handles - the population dispatch fans events out to.
   */
  readonly #listeners: Map<
    DocHandle<any>,
    Map<string, Set<Function>>
  > = new Map()

  constructor(private readonly state: DocumentState) {
    state.on("change", payload => this.dispatchChange(payload))
    state.on("heads-changed", payload => this.dispatchHeadsChanged(payload))
    state.on("delete", () => this.dispatchDelete())
    state.on("remote-heads", payload => this.dispatchRemoteHeads(payload))
    state.on("ephemeral-message", payload =>
      this.dispatchEphemeral(payload)
    )
    state.on("ephemeral-message-outbound", payload =>
      this.dispatchEphemeralOutbound(payload)
    )
  }

  // ---------------- Identity (trie-as-handle-cache) ----------------

  /**
   * Get-or-create the trie node for `symbolicPath`. Creates intermediate
   * nodes and pattern edges as needed. O(depth).
   */
  getOrCreateNode(symbolicPath: readonly PathSegment[]): TrieNode {
    let node = this.root
    for (const seg of symbolicPath) {
      node = descendCreating(node, seg)
    }
    return node
  }

  /**
   * Look up the canonical handle at `(node, range, fixedHeads)`. Returns
   * `undefined` if no handle is currently cached or the cached one has
   * been GC'd.
   */
  cachedHandle(
    node: TrieNode,
    range: CursorRange | undefined,
    fixedHeads: UrlHeads | undefined
  ): DocHandle<any> | undefined {
    return node.handles.get(variantKey(range, fixedHeads))?.deref()
  }

  /** Cache `handle` at `(node, range, fixedHeads)`. */
  cacheHandle(
    node: TrieNode,
    range: CursorRange | undefined,
    fixedHeads: UrlHeads | undefined,
    handle: DocHandle<any>
  ): void {
    node.handles.set(variantKey(range, fixedHeads), new WeakRef(handle))
  }

  // ---------------- Resolution (trie-as-pattern-cache) ----------------

  /**
   * Walk `symbolicPath` against `doc`, resolving each segment to a
   * concrete prop. Pattern segments consult / refresh the trie's
   * pattern-edge cache: if `fixedHeads` is set we never touch the
   * cache (view-pinned reads are at frozen heads, not the live state),
   * otherwise we use cached resolution if `resolvedAtHeads` matches the
   * current doc heads and refresh otherwise.
   *
   * Returns `undefined` if any segment fails to resolve.
   *
   * O(depth) when the cache is warm. O(depth + |array|) per cold pattern
   * segment.
   */
  resolvePropPath(
    symbolicPath: readonly PathSegment[],
    doc: A.Doc<any>,
    fixedHeads: UrlHeads | undefined
  ): Prop[] | undefined {
    if (symbolicPath.length === 0) return []
    const docHeadsKey =
      fixedHeads && fixedHeads.length > 0
        ? undefined
        : headsKey(encodeHeads(A.getHeads(doc)))

    let node: TrieNode | undefined = this.root
    let cursor: unknown = doc
    const out: Prop[] = []

    for (const seg of symbolicPath) {
      let prop: Prop | undefined
      let nextNode: TrieNode | undefined

      switch (seg[KIND]) {
        case "key":
          prop = seg.key
          nextNode = node?.children.get(seg.key)
          break
        case "index":
          prop = seg.index
          nextNode = node?.children.get(seg.index)
          break
        case "match": {
          const edge = node ? findPatternEdge(node, seg.match) : undefined
          if (edge && docHeadsKey !== undefined) {
            // Live read - cache is keyed by current doc heads.
            if (edge.resolvedAtHeads !== docHeadsKey) {
              edge.resolvedIndex = findFirstMatch(cursor, seg.match)
              edge.resolvedAtHeads = docHeadsKey
            }
            prop = edge.resolvedIndex
          } else {
            // View-pinned read or no trie edge: resolve fresh.
            prop = findFirstMatch(cursor, seg.match)
          }
          nextNode = edge?.node
          break
        }
      }

      if (prop === undefined) return undefined
      out.push(prop)
      cursor =
        cursor === null || cursor === undefined
          ? undefined
          : (cursor as any)[prop as any]
      node = nextNode
    }

    return out
  }

  // ---------------- Listener storage + retention ----------------
  //
  // Listeners are owned here rather than on the handle. The map's keys
  // are the strong references that keep handles alive while they have
  // listeners attached - retention is structural, not a separate Set.
  //
  // `DocHandle.on/off/once/...` are thin delegators to these methods.
  // The dispatch path (below) iterates `#listeners.keys()` directly.

  addListener(handle: DocHandle<any>, event: string, fn: Function): void {
    let m = this.#listeners.get(handle)
    if (!m) {
      m = new Map()
      this.#listeners.set(handle, m)
    }
    let s = m.get(event)
    if (!s) {
      s = new Set()
      m.set(event, s)
    }
    s.add(fn)
  }

  removeListener(handle: DocHandle<any>, event: string, fn: Function): void {
    const m = this.#listeners.get(handle)
    if (!m) return
    const s = m.get(event)
    if (!s) return
    s.delete(fn)
    if (s.size === 0) m.delete(event)
    if (m.size === 0) this.#listeners.delete(handle)
  }

  removeAllListenersForHandle(handle: DocHandle<any>): void {
    this.#listeners.delete(handle)
  }

  removeAllListenersForEvent(handle: DocHandle<any>, event: string): void {
    const m = this.#listeners.get(handle)
    if (!m) return
    m.delete(event)
    if (m.size === 0) this.#listeners.delete(handle)
  }

  hasListeners(handle: DocHandle<any>): boolean {
    return this.#listeners.has(handle)
  }

  listenersFor(handle: DocHandle<any>, event: string): Function[] {
    const s = this.#listeners.get(handle)?.get(event)
    return s ? Array.from(s) : []
  }

  listenerCountFor(handle: DocHandle<any>, event: string): number {
    return this.#listeners.get(handle)?.get(event)?.size ?? 0
  }

  eventNamesFor(handle: DocHandle<any>): string[] {
    const m = this.#listeners.get(handle)
    return m ? Array.from(m.keys()) : []
  }

  /** @internal Number of handles with at least one listener. Used by tests. */
  get retainedCount(): number {
    return this.#listeners.size
  }

  /**
   * Deliver `event` on `handle` to its listeners. Snapshot the listener
   * set before iterating so once-handlers (which remove themselves
   * during execution) don't perturb the loop. Swallows exceptions per
   * listener so a single failure doesn't block fan-out.
   */
  emit(handle: DocHandle<any>, event: string, payload: unknown): boolean {
    const s = this.#listeners.get(handle)?.get(event)
    if (!s || s.size === 0) return false
    for (const fn of Array.from(s)) {
      try {
        ;(fn as any)(payload)
      } catch (e) {
        this.state.log("error in handle listener: %o", e)
      }
    }
    return true
  }

  // ---------------- Dispatch ----------------

  /**
   * Fan out a `change` to every retained handle. Walks the trie once per
   * patch, gathering affected handles and bulk-resolving any pattern
   * edges crossed. Frozen (fixed-heads) handles are skipped: their
   * content can't change so they have nothing to fire.
   */
  dispatchChange(payload: DocumentChangePayload): void {
    const perHandle = new Map<DocHandle<any>, A.Patch[]>()
    const resolvedNodes = new Set<TrieNode>()
    const docHeadsKey = headsKey(encodeHeads(A.getHeads(payload.doc)))

    for (const patch of payload.patches) {
      collectForPatch(
        this.root,
        patch.path,
        0,
        payload.doc,
        patch,
        perHandle,
        resolvedNodes,
        docHeadsKey
      )
    }

    for (const handle of this.#listeners.keys()) {
      if (handle.isReadOnly()) continue
      const filtered = perHandle.get(handle)
      if (!filtered || filtered.length === 0) continue
      this.emit(handle, "change", {
        handle,
        doc: payload.doc,
        patches: filtered,
        patchInfo: payload.patchInfo,
      })
    }
  }

  dispatchHeadsChanged(payload: DocumentHeadsChangedPayload): void {
    for (const handle of this.#listeners.keys()) {
      if (handle.isReadOnly()) continue
      this.emit(handle, "heads-changed", { handle, doc: payload.doc })
    }
  }

  dispatchDelete(): void {
    for (const handle of this.#listeners.keys()) {
      this.emit(handle, "delete", { handle })
    }
  }

  dispatchRemoteHeads(payload: DocumentRemoteHeadsPayload): void {
    for (const handle of this.#listeners.keys()) {
      this.emit(handle, "remote-heads", payload)
    }
  }

  dispatchEphemeral(payload: DocumentEphemeralMessagePayload): void {
    for (const handle of this.#listeners.keys()) {
      this.emit(handle, "ephemeral-message", { handle, ...payload })
    }
  }

  dispatchEphemeralOutbound(
    payload: DocumentEphemeralMessageOutboundPayload
  ): void {
    for (const handle of this.#listeners.keys()) {
      this.emit(handle, "ephemeral-message-outbound", {
        handle,
        ...payload,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Trie data + helpers
// ---------------------------------------------------------------------------

export type TrieNode = {
  /** Literal-segment edges, keyed by the literal prop (string or number). */
  children: Map<Prop, TrieNode>
  /** Pattern-segment edges. Linear search by structural pattern equality. */
  patternEdges: PatternEdge[]
  /**
   * All distinct handles at this symbolic path, keyed by their variant
   * discriminator (range + fixed heads). `""` is the canonical "live,
   * no range" handle. Each is a `WeakRef`; dead refs are pruned lazily
   * during dispatch.
   */
  handles: Map<string, WeakRef<DocHandle<any>>>
}

export type PatternEdge = {
  pattern: Pattern
  node: TrieNode
  /** Cached matched index, valid as of `resolvedAtHeads`. */
  resolvedIndex: number | undefined
  /** Doc heads (encoded) the cached `resolvedIndex` was computed against. */
  resolvedAtHeads: string | undefined
}

function emptyNode(): TrieNode {
  return {
    children: new Map(),
    patternEdges: [],
    handles: new Map(),
  }
}

/**
 * Find or create the child node for `seg` under `node`. Pattern edges
 * are deduplicated by structural pattern equality so refs sharing a
 * pattern share an edge (and hence its cached resolution).
 */
function descendCreating(node: TrieNode, seg: PathSegment): TrieNode {
  switch (seg[KIND]) {
    case "key": {
      let child = node.children.get(seg.key)
      if (!child) {
        child = emptyNode()
        node.children.set(seg.key, child)
      }
      return child
    }
    case "index": {
      let child = node.children.get(seg.index)
      if (!child) {
        child = emptyNode()
        node.children.set(seg.index, child)
      }
      return child
    }
    case "match": {
      let edge = findPatternEdge(node, seg.match)
      if (!edge) {
        edge = {
          pattern: seg.match,
          node: emptyNode(),
          resolvedIndex: undefined,
          resolvedAtHeads: undefined,
        }
        node.patternEdges.push(edge)
      }
      return edge.node
    }
  }
}

function findPatternEdge(
  node: TrieNode,
  pattern: Pattern
): PatternEdge | undefined {
  for (const edge of node.patternEdges) {
    if (patternsEqual(edge.pattern, pattern)) return edge
  }
  return undefined
}

function patternsEqual(a: Pattern, b: Pattern): boolean {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (a[key] !== b[key]) return false
  }
  return true
}

function findFirstMatch(
  container: unknown,
  pattern: Pattern
): number | undefined {
  if (!Array.isArray(container)) return undefined
  for (let i = 0; i < (container as unknown[]).length; i++) {
    if (matchesPattern((container as unknown[])[i], pattern)) return i
  }
  return undefined
}

function readStep(cursor: unknown, step: Prop): unknown {
  if (cursor === null || cursor === undefined) return undefined
  return (cursor as any)[step as any]
}

/**
 * Bulk-resolve all pattern edges at a single array node in one pass.
 * Iterates the array carrying a working set of unresolved patterns;
 * matched patterns drop out; early-exits when the set is empty.
 *
 * Cost: O(|array| × |unresolvedPatterns|) with early exit. Two refs
 * sharing a pattern at the same path share an edge and so cost only
 * one comparison per array item.
 */
function bulkResolvePatternEdges(
  node: TrieNode,
  cursor: unknown,
  resolvedNodes: Set<TrieNode>,
  docHeadsKey: string
): void {
  if (node.patternEdges.length === 0) return
  if (!Array.isArray(cursor)) return
  if (resolvedNodes.has(node)) return
  resolvedNodes.add(node)

  // Reset all edges; we'll re-resolve in this pass.
  const unresolved = new Set<PatternEdge>()
  for (const edge of node.patternEdges) {
    edge.resolvedIndex = undefined
    edge.resolvedAtHeads = docHeadsKey
    unresolved.add(edge)
  }

  for (
    let i = 0;
    i < (cursor as unknown[]).length && unresolved.size > 0;
    i++
  ) {
    const item = (cursor as unknown[])[i]
    for (const edge of unresolved) {
      if (matchesPattern(item, edge.pattern)) {
        edge.resolvedIndex = i
        unresolved.delete(edge)
      }
    }
  }
  // Remaining edges keep `resolvedIndex: undefined` from the reset.
}

/**
 * Walk the trie along one patch's path, collecting affected handles.
 * Refreshes pattern edges (bulk-resolve) at each array node visited.
 */
function collectForPatch(
  node: TrieNode,
  patchPath: readonly Prop[],
  i: number,
  cursor: unknown,
  patch: A.Patch,
  out: Map<DocHandle<any>, A.Patch[]>,
  resolvedNodes: Set<TrieNode>,
  docHeadsKey: string
): void {
  addPatchForNode(node, patch, out)
  bulkResolvePatternEdges(node, cursor, resolvedNodes, docHeadsKey)

  if (i >= patchPath.length) {
    // Patch terminates at or above this node. Everything below is
    // affected; descendant pattern indices stay valid because their
    // arrays weren't touched by this patch.
    collectDescendants(node, patch, out)
    return
  }

  const step = patchPath[i]
  const literalChild = node.children.get(step)
  if (literalChild) {
    collectForPatch(
      literalChild,
      patchPath,
      i + 1,
      readStep(cursor, step),
      patch,
      out,
      resolvedNodes,
      docHeadsKey
    )
  }

  if (node.patternEdges.length > 0) {
    const next = readStep(cursor, step)
    for (const edge of node.patternEdges) {
      if (edge.resolvedIndex !== undefined && edge.resolvedIndex === step) {
        collectForPatch(
          edge.node,
          patchPath,
          i + 1,
          next,
          patch,
          out,
          resolvedNodes,
          docHeadsKey
        )
      }
    }
  }
}

/**
 * BFS over `node`'s descendants, adding the patch to every retained
 * handle reached. Doesn't re-resolve pattern edges (descendant arrays
 * weren't touched by this patch).
 */
function collectDescendants(
  node: TrieNode,
  patch: A.Patch,
  out: Map<DocHandle<any>, A.Patch[]>
): void {
  const queue: TrieNode[] = []
  for (const child of node.children.values()) queue.push(child)
  for (const edge of node.patternEdges) queue.push(edge.node)
  while (queue.length > 0) {
    const current = queue.shift()!
    addPatchForNode(current, patch, out)
    for (const child of current.children.values()) queue.push(child)
    for (const edge of current.patternEdges) queue.push(edge.node)
  }
}

/**
 * Add `patch` to every writeable (non-fixed-heads) handle at `node`.
 * Read-only variants (view-pinned, fixed-heads) are skipped: they
 * never receive change events. Dead WeakRefs are pruned lazily.
 */
function addPatchForNode(
  node: TrieNode,
  patch: A.Patch,
  out: Map<DocHandle<any>, A.Patch[]>
): void {
  if (node.handles.size === 0) return
  for (const [key, ref] of node.handles) {
    const handle = ref.deref()
    if (!handle) {
      node.handles.delete(key)
      continue
    }
    if (handle.isReadOnly()) continue
    const existing = out.get(handle)
    if (existing) existing.push(patch)
    else out.set(handle, [patch])
  }
}

/** Canonical key for a `UrlHeads` array - comma-joined and sorted-stable. */
export function headsKey(heads: UrlHeads): string {
  return heads.join(",")
}

/**
 * Identity discriminator within a trie node: groups handles at the same
 * symbolic path by their range (if any) and fixed heads (if any). `""`
 * is the canonical live, no-range handle.
 */
function variantKey(
  range: CursorRange | undefined,
  fixedHeads: UrlHeads | undefined
): string {
  const r = range ? `${range.start}-${range.end}` : ""
  const h =
    fixedHeads && fixedHeads.length > 0 ? `#${headsKey(fixedHeads)}` : ""
  return `${r}${h}`
}
