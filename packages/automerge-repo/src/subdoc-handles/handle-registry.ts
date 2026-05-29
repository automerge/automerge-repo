import { next as A } from "@automerge/automerge/slim"
import type { Prop } from "@automerge/automerge/slim"
import type { UrlHeads, PeerId } from "../types.js"
import type { StorageId } from "../storage/types.js"
import type { Document } from "../Document.js"
import type { DocHandle } from "../DocHandle.js"
import { KIND } from "./types.js"
import type { CursorRange, PathSegment, Pattern } from "./types.js"
import { matchesPattern } from "./utils.js"

/** Event listener stored in the registry. Payload shape is event-specific. */
type Listener = (payload: any) => void

/**
 * A change accumulated for one handle during dispatch: patches already
 * re-rooted relative to the handle's scope, plus whether the scope itself
 * was replaced or removed (a change at/above the scope boundary).
 */
type ScopedChange = { patches: A.Patch[]; scopeReplaced: boolean }

/**
 * Per-document trie that owns handle identity, pattern resolution caching,
 * dispatch, and listener retention.
 *
 * Each symbolic path is exactly one trie node, carrying a
 * `Map<variantKey, WeakRef<DocHandle>>` for all variants at that path
 * (live / view-pinned / range / range+pinned). Pattern segments live as
 * `PatternEdge`s on the parent node with a cached `(resolvedIndex,
 * resolvedAtHeads)` pair - the sole pattern-resolution cache.
 *
 * Reads walk the trie: O(depth) warm, O(depth + |array|) per cold pattern.
 * Dispatch walks the trie once per patch and bulk-resolves crossed pattern
 * edges - N refs sharing a pattern at the same path cost the same as one.
 */
export class HandleRegistry {
  /** Trie root - the document at path `[]`. */
  readonly root: TrieNode = emptyNode([])

  /**
   * Prunes a handle's trie node once the handle is garbage-collected, so the
   * trie can't grow without bound as transient sub-handles (e.g. ever-changing
   * `{ id }` patterns) come and go. The held token is everything we need to
   * find and detach the entry. A handle with listeners is held strongly by
   * `#listeners`, so it won't be collected (and won't be pruned) until those
   * are removed.
   */
  readonly #finalizer = new FinalizationRegistry<{
    path: readonly PathSegment[]
    variantKey: string
  }>(token => this.#pruneDeadHandle(token.path, token.variantKey))

  /**
   * `handle → event → callbacks`. Strong on handles, so any handle with a
   * listener is retained structurally - no separate retainer set.
   */
  readonly #listeners: Map<DocHandle<any>, Map<string, Set<Listener>>> =
    new Map()

  constructor(readonly document: Document<any>) {}

  // Identity (trie-as-handle-cache)

  /** Get-or-create the trie node for `symbolicPath`. O(depth). */
  getOrCreateNode(symbolicPath: readonly PathSegment[]): TrieNode {
    let node = this.root
    for (const seg of symbolicPath) {
      node = descendCreating(node, seg)
    }
    return node
  }

  /** Canonical handle at `(node, range, fixedHeads)`, or `undefined` if GC'd. */
  cachedHandle(
    node: TrieNode,
    range: CursorRange | undefined,
    fixedHeads: UrlHeads | undefined
  ): DocHandle<any> | undefined {
    return node.handles.get(variantKey(range, fixedHeads))?.deref()
  }

  /** Cache `handle` at `(node, range, fixedHeads)`. */
  cacheHandle<T>(
    node: TrieNode,
    range: CursorRange | undefined,
    fixedHeads: UrlHeads | undefined,
    handle: DocHandle<T>
  ): void {
    const key = variantKey(range, fixedHeads)
    node.handles.set(key, new WeakRef(handle))
    this.#finalizer.register(handle, { path: node.path, variantKey: key })
  }

  /**
   * Called by the finalizer after a handle is collected: drop its (now-dead)
   * entry and prune any trie nodes that became empty, walking up to the root.
   * No-ops if the slot was re-cached with a live handle in the meantime.
   */
  #pruneDeadHandle(path: readonly PathSegment[], variantKey: string): void {
    // Re-walk from the root, recording the chain so we can prune bottom-up.
    const chain: { parent: TrieNode; seg: PathSegment; node: TrieNode }[] = []
    let node: TrieNode = this.root
    for (const seg of path) {
      const child = descend(node, seg)
      if (!child) return // already pruned
      chain.push({ parent: node, seg, node: child })
      node = child
    }

    const ref = node.handles.get(variantKey)
    if (!ref || ref.deref() !== undefined) return // re-cached with a live handle
    node.handles.delete(variantKey)

    for (let i = chain.length - 1; i >= 0; i--) {
      const { parent, seg, node: n } = chain[i]
      if (!nodeIsEmpty(n)) break
      removeChild(parent, seg)
    }
  }

  /** @internal Total number of trie nodes (root included). For tests. */
  get nodeCount(): number {
    let count = 0
    const queue: TrieNode[] = [this.root]
    while (queue.length > 0) {
      const n = queue.shift()!
      count++
      for (const child of n.children.values()) queue.push(child)
      for (const edge of n.patternEdges) queue.push(edge.node)
    }
    return count
  }

  // Resolution (trie-as-pattern-cache)

  /**
   * Walk `symbolicPath` against `doc` to a concrete prop path. Pattern
   * segments use the trie's cached resolution when the doc's heads match
   * `resolvedAtHeads`; view-pinned reads bypass the cache. Returns
   * `undefined` if any segment fails to resolve.
   *
   * O(depth) warm; O(depth + |array|) per cold pattern.
   */
  resolvePropPath(
    symbolicPath: readonly PathSegment[],
    doc: A.Doc<any>,
    fixedHeads: UrlHeads | undefined
  ): Prop[] | undefined {
    if (symbolicPath.length === 0) return []
    // Raw hex key - no bs58 encoding on hot reads.
    const docHeadsKey =
      fixedHeads && fixedHeads.length > 0
        ? undefined
        : headsKey(A.getHeads(doc))

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
            // View-pinned read (no cache) or no trie edge: resolve fresh.
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

  // Listener storage. `DocHandle.on/off/once/...` delegate here.
  // Generic over `T` so callers can pass `this` without casting; storage erases to any.

  addListener<T>(handle: DocHandle<T>, event: string, fn: Listener): void {
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

  removeListener<T>(handle: DocHandle<T>, event: string, fn: Listener): void {
    const m = this.#listeners.get(handle)
    if (!m) return
    const s = m.get(event)
    if (!s) return
    s.delete(fn)
    if (s.size === 0) m.delete(event)
    if (m.size === 0) this.#listeners.delete(handle)
  }

  removeAllListenersForHandle<T>(handle: DocHandle<T>): void {
    this.#listeners.delete(handle)
  }

  removeAllListenersForEvent<T>(handle: DocHandle<T>, event: string): void {
    const m = this.#listeners.get(handle)
    if (!m) return
    m.delete(event)
    if (m.size === 0) this.#listeners.delete(handle)
  }

  hasListeners<T>(handle: DocHandle<T>): boolean {
    return this.#listeners.has(handle)
  }

  listenersFor<T>(handle: DocHandle<T>, event: string): Listener[] {
    const s = this.#listeners.get(handle)?.get(event)
    return s ? Array.from(s) : []
  }

  listenerCountFor<T>(handle: DocHandle<T>, event: string): number {
    return this.#listeners.get(handle)?.get(event)?.size ?? 0
  }

  eventNamesFor<T>(handle: DocHandle<T>): string[] {
    const m = this.#listeners.get(handle)
    return m ? Array.from(m.keys()) : []
  }

  /** @internal Number of handles with at least one listener. */
  get retainedCount(): number {
    return this.#listeners.size
  }

  /**
   * Deliver `event` on `handle` to its listeners. Snapshots the set so
   * once-handlers can self-remove without perturbing the loop. Swallows
   * per-listener exceptions.
   */
  emit<T>(handle: DocHandle<T>, event: string, payload: unknown): boolean {
    const s = this.#listeners.get(handle)?.get(event)
    if (!s || s.size === 0) return false
    for (const fn of Array.from(s)) {
      try {
        ;(fn as any)(payload)
      } catch (e) {
        this.document.log("error in handle listener: %o", e)
      }
    }
    return true
  }

  // Dispatch

  /**
   * Fan `change` out to writeable handles. One trie walk per patch;
   * crossed pattern edges are bulk-resolved. Fixed-heads handles skipped.
   */
  dispatchChange(
    doc: A.Doc<any>,
    patches: A.Patch[],
    patchInfo: A.PatchInfo<any>
  ): void {
    const perHandle = new Map<DocHandle<any>, ScopedChange>()
    const resolvedNodes = new Set<TrieNode>()
    const docHeadsKey = headsKey(A.getHeads(doc))
    const before = patchInfo.before
    // Pattern edges are resolved against *both* the before- and after-state
    // (once per node, gated by `resolvedNodes`). `patternBefore` carries the
    // before-index so the walk can tell stable matches (descend for content)
    // from ones that appeared / disappeared / moved (whole scope replaced).
    const patternBefore = new Map<PatternEdge, number | undefined>()

    // Patches are trimmed to each handle's scope as the trie is walked - the
    // descent depth is exactly the scope length, so paths are re-rooted (and
    // boundary changes flagged) inline, with no second pass.
    for (const patch of patches) {
      collectForPatch(
        this.root,
        patch.path,
        0,
        doc,
        before,
        patch,
        perHandle,
        resolvedNodes,
        patternBefore,
        docHeadsKey
      )
    }

    for (const handle of this.#listeners.keys()) {
      if (handle.isReadOnly()) continue
      const scoped = perHandle.get(handle)
      if (!scoped) continue
      if (scoped.patches.length === 0 && !scoped.scopeReplaced) continue
      this.emit(handle, "change", {
        handle,
        doc: handle.doc(),
        patches: scoped.patches,
        scopeReplaced: scoped.scopeReplaced,
        patchInfo,
      })
    }
  }

  /**
   * Fan `heads-changed` out to writeable handles (skips fixed-heads).
   * Heads are a document-level concept, so the payload carries the whole
   * document (unlike `change`, whose `doc` is scoped to each handle).
   */
  dispatchHeadsChanged(doc: A.Doc<any>): void {
    for (const handle of this.#listeners.keys()) {
      if (handle.isReadOnly()) continue
      this.emit(handle, "heads-changed", { handle, doc })
    }
  }

  /** Fan out a `delete` to every retained handle (read-only included). */
  dispatchDelete(): void {
    for (const handle of this.#listeners.keys()) {
      this.emit(handle, "delete", { handle })
    }
  }

  /** Fan out a `remote-heads` notification (document-level event). */
  dispatchRemoteHeads(
    storageId: StorageId,
    heads: UrlHeads,
    timestamp: number
  ): void {
    for (const handle of this.#listeners.keys()) {
      this.emit(handle, "remote-heads", { storageId, heads, timestamp })
    }
  }

  /** Fan out an inbound ephemeral message to every retained handle. */
  dispatchEphemeral(senderId: PeerId, message: unknown): void {
    for (const handle of this.#listeners.keys()) {
      this.emit(handle, "ephemeral-message", {
        handle,
        senderId,
        message,
      })
    }
  }

  /** Fan out an outbound ephemeral broadcast (typically picked up by network adapters). */
  dispatchEphemeralOutbound(data: Uint8Array): void {
    for (const handle of this.#listeners.keys()) {
      this.emit(handle, "ephemeral-message-outbound", { handle, data })
    }
  }
}

// Trie data + helpers

export type TrieNode = {
  /** Symbolic path from the root to this node (empty at the root). Used to prune. */
  path: readonly PathSegment[]
  /** Literal-segment edges keyed by the literal prop. */
  children: Map<Prop, TrieNode>
  /** Pattern-segment edges (linear search, structural equality). */
  patternEdges: PatternEdge[]
  /** Handles at this path keyed by variant (range + fixed heads); `""` is the live, no-range handle. */
  handles: Map<string, WeakRef<DocHandle<any>>>
}

export type PatternEdge = {
  pattern: Pattern
  node: TrieNode
  /** Cached matched index, valid as of `resolvedAtHeads`. */
  resolvedIndex: number | undefined
  /** Doc heads the cached `resolvedIndex` was computed against. */
  resolvedAtHeads: string | undefined
}

function emptyNode(path: readonly PathSegment[]): TrieNode {
  return {
    path,
    children: new Map(),
    patternEdges: [],
    handles: new Map(),
  }
}

function descendCreating(node: TrieNode, seg: PathSegment): TrieNode {
  switch (seg[KIND]) {
    case "key": {
      let child = node.children.get(seg.key)
      if (!child) {
        child = emptyNode([...node.path, seg])
        node.children.set(seg.key, child)
      }
      return child
    }
    case "index": {
      let child = node.children.get(seg.index)
      if (!child) {
        child = emptyNode([...node.path, seg])
        node.children.set(seg.index, child)
      }
      return child
    }
    case "match": {
      let edge = findPatternEdge(node, seg.match)
      if (!edge) {
        edge = {
          pattern: seg.match,
          node: emptyNode([...node.path, seg]),
          resolvedIndex: undefined,
          resolvedAtHeads: undefined,
        }
        node.patternEdges.push(edge)
      }
      return edge.node
    }
  }
}

/** Non-creating descent: returns the child node for `seg`, or `undefined`. */
function descend(node: TrieNode, seg: PathSegment): TrieNode | undefined {
  switch (seg[KIND]) {
    case "key":
      return node.children.get(seg.key)
    case "index":
      return node.children.get(seg.index)
    case "match":
      return findPatternEdge(node, seg.match)?.node
  }
}

/** A node with no handles, child nodes, or pattern edges carries no state. */
function nodeIsEmpty(node: TrieNode): boolean {
  return (
    node.handles.size === 0 &&
    node.children.size === 0 &&
    node.patternEdges.length === 0
  )
}

/** Remove the child reached from `parent` via `seg`. */
function removeChild(parent: TrieNode, seg: PathSegment): void {
  switch (seg[KIND]) {
    case "key":
      parent.children.delete(seg.key)
      break
    case "index":
      parent.children.delete(seg.index)
      break
    case "match": {
      const i = parent.patternEdges.findIndex(e =>
        patternsEqual(e.pattern, seg.match)
      )
      if (i !== -1) parent.patternEdges.splice(i, 1)
      break
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
 * Match every pattern edge at `arr` in a single pass, with a shrinking
 * working set + early exit so N edges sharing one array cost one comparison
 * per item. `assign(edge, index | undefined)` records each result.
 */
function bulkMatch(
  edges: readonly PatternEdge[],
  arr: unknown,
  assign: (edge: PatternEdge, index: number | undefined) => void
): void {
  for (const edge of edges) assign(edge, undefined)
  if (!Array.isArray(arr)) return
  const pending = new Set(edges)
  for (let i = 0; i < (arr as unknown[]).length && pending.size > 0; i++) {
    const item = (arr as unknown[])[i]
    for (const edge of pending) {
      if (matchesPattern(item, edge.pattern)) {
        assign(edge, i)
        pending.delete(edge)
      }
    }
  }
}

/**
 * Resolve a node's pattern edges against both the after- and before-state
 * (once per node, gated by `resolvedNodes`). The after-index updates the
 * read cache (`resolvedIndex` / `resolvedAtHeads`); the before-index goes
 * into `patternBefore`. Any edge whose match *moved, appeared, or
 * disappeared* (before !== after) has its whole sub-tree marked
 * `scopeReplaced`, since the value those handles point at changed wholesale.
 */
function resolvePatternEdges(
  node: TrieNode,
  afterCursor: unknown,
  beforeCursor: unknown,
  resolvedNodes: Set<TrieNode>,
  patternBefore: Map<PatternEdge, number | undefined>,
  docHeadsKey: string,
  out: Map<DocHandle<any>, ScopedChange>
): void {
  if (node.patternEdges.length === 0) return
  if (resolvedNodes.has(node)) return
  resolvedNodes.add(node)

  bulkMatch(node.patternEdges, afterCursor, (edge, idx) => {
    edge.resolvedIndex = idx
    edge.resolvedAtHeads = docHeadsKey
  })
  bulkMatch(node.patternEdges, beforeCursor, (edge, idx) => {
    patternBefore.set(edge, idx)
  })

  for (const edge of node.patternEdges) {
    if (patternBefore.get(edge) !== edge.resolvedIndex) {
      markScopeReplaced(edge.node, out)
    }
  }
}

/** Mark every writeable handle in `node`'s sub-tree as `scopeReplaced`. */
function markScopeReplaced(
  node: TrieNode,
  out: Map<DocHandle<any>, ScopedChange>
): void {
  const queue: TrieNode[] = [node]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const [key, ref] of current.handles) {
      const handle = ref.deref()
      if (!handle) {
        current.handles.delete(key)
        continue
      }
      if (handle.isReadOnly()) continue
      let acc = out.get(handle)
      if (!acc) {
        acc = { patches: [], scopeReplaced: false }
        out.set(handle, acc)
      }
      acc.scopeReplaced = true
    }
    for (const child of current.children.values()) queue.push(child)
    for (const edge of current.patternEdges) queue.push(edge.node)
  }
}

/** Walk the trie along one patch path, collecting affected handles. */
function collectForPatch(
  node: TrieNode,
  patchPath: readonly Prop[],
  depth: number,
  afterCursor: unknown,
  beforeCursor: unknown,
  patch: A.Patch,
  out: Map<DocHandle<any>, ScopedChange>,
  resolvedNodes: Set<TrieNode>,
  patternBefore: Map<PatternEdge, number | undefined>,
  docHeadsKey: string
): void {
  // `depth` is the number of segments from the root to `node`, i.e. the
  // scope length of any handle living here - exactly what we slice paths by.
  addPatchForNode(node, patch, out, depth)
  resolvePatternEdges(
    node,
    afterCursor,
    beforeCursor,
    resolvedNodes,
    patternBefore,
    docHeadsKey,
    out
  )

  if (depth >= patchPath.length) {
    // Patch ends at/above this node - everything below is affected.
    collectDescendants(node, patch, out, depth)
    return
  }

  const step = patchPath[depth]
  const literalChild = node.children.get(step)
  if (literalChild) {
    collectForPatch(
      literalChild,
      patchPath,
      depth + 1,
      readStep(afterCursor, step),
      readStep(beforeCursor, step),
      patch,
      out,
      resolvedNodes,
      patternBefore,
      docHeadsKey
    )
  }

  // Only descend pattern edges whose match is *stable* (same index before and
  // after) and located at `step` - those collect content patches. Edges that
  // moved / appeared / disappeared were already handled wholesale via
  // `scopeReplaced` in `resolvePatternEdges`.
  if (node.patternEdges.length > 0) {
    const nextAfter = readStep(afterCursor, step)
    for (const edge of node.patternEdges) {
      const idxAfter = edge.resolvedIndex
      if (
        idxAfter !== undefined &&
        idxAfter === step &&
        idxAfter === patternBefore.get(edge)
      ) {
        collectForPatch(
          edge.node,
          patchPath,
          depth + 1,
          nextAfter,
          readStep(beforeCursor, idxAfter),
          patch,
          out,
          resolvedNodes,
          patternBefore,
          docHeadsKey
        )
      }
    }
  }
}

function collectDescendants(
  node: TrieNode,
  patch: A.Patch,
  out: Map<DocHandle<any>, ScopedChange>,
  depth: number
): void {
  const queue: Array<[TrieNode, number]> = []
  for (const child of node.children.values()) queue.push([child, depth + 1])
  for (const edge of node.patternEdges) queue.push([edge.node, depth + 1])
  while (queue.length > 0) {
    const [current, currentDepth] = queue.shift()!
    addPatchForNode(current, patch, out, currentDepth)
    for (const child of current.children.values()) {
      queue.push([child, currentDepth + 1])
    }
    for (const edge of current.patternEdges) {
      queue.push([edge.node, currentDepth + 1])
    }
  }
}

/**
 * Accumulate `patch` for every writeable handle at `node`, trimmed to the
 * handle's scope (`depth` segments deep); prunes dead WeakRefs. A patch at or
 * above the scope boundary (`path.length <= depth`) replaces/removes the
 * scope wholesale, so it sets `scopeReplaced` instead of contributing a path.
 */
function addPatchForNode(
  node: TrieNode,
  patch: A.Patch,
  out: Map<DocHandle<any>, ScopedChange>,
  depth: number
): void {
  if (node.handles.size === 0) return
  for (const [key, ref] of node.handles) {
    const handle = ref.deref()
    if (!handle) {
      node.handles.delete(key)
      continue
    }
    if (handle.isReadOnly()) continue
    let acc = out.get(handle)
    if (!acc) {
      acc = { patches: [], scopeReplaced: false }
      out.set(handle, acc)
    }
    if (patch.path.length <= depth) {
      acc.scopeReplaced = true
    } else if (depth === 0) {
      acc.patches.push(patch)
    } else {
      acc.patches.push({ ...patch, path: patch.path.slice(depth) } as A.Patch)
    }
  }
}

/**
 * Canonical key for a heads array. Sorted so reordered inputs collide.
 * Works on both `UrlHeads` (bs58check) and raw `A.Heads` (hex) - they're
 * never compared against each other so they can't collide.
 */
function headsKey(heads: readonly string[]): string {
  return [...heads].sort().join(",")
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
