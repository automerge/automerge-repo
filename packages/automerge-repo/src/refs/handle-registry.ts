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
  readonly root: TrieNode = emptyNode()

  /**
   * `handle → event → callbacks`. Strong on handles, so any handle with a
   * listener is retained structurally - no separate retainer set.
   */
  readonly #listeners: Map<DocHandle<any>, Map<string, Set<Listener>>> =
    new Map()

  constructor(readonly document: Document<any>) {}

  // ---------------- Identity (trie-as-handle-cache) ----------------

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
    node.handles.set(variantKey(range, fixedHeads), new WeakRef(handle))
  }

  // ---------------- Resolution (trie-as-pattern-cache) ----------------

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

  // ---------------- Dispatch ----------------

  /**
   * Fan `change` out to writeable handles. One trie walk per patch;
   * crossed pattern edges are bulk-resolved. Fixed-heads handles skipped.
   */
  dispatchChange(
    doc: A.Doc<any>,
    patches: A.Patch[],
    patchInfo: A.PatchInfo<any>
  ): void {
    const perHandle = new Map<DocHandle<any>, A.Patch[]>()
    const resolvedNodes = new Set<TrieNode>()
    const docHeadsKey = headsKey(A.getHeads(doc))

    for (const patch of patches) {
      collectForPatch(
        this.root,
        patch.path,
        0,
        doc,
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
        doc,
        patches: filtered,
        patchInfo,
      })
    }
  }

  /** Fan `heads-changed` out to writeable handles (skips fixed-heads). */
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

// ---------------------------------------------------------------------------
// Trie data + helpers
// ---------------------------------------------------------------------------

export type TrieNode = {
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

function emptyNode(): TrieNode {
  return {
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
 * Resolve all pattern edges at one array node in a single pass. Carries
 * a shrinking working set of unresolved patterns; early-exits on empty.
 * Refs sharing a pattern share an edge so they cost one comparison total.
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
}

/** Walk the trie along one patch path, collecting affected handles. */
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
    // Patch ends at/above this node - everything below is affected.
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

/** Add `patch` to every writeable handle at `node`; prunes dead WeakRefs. */
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
