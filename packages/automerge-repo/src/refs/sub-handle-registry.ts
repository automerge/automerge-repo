import type * as A from "@automerge/automerge/slim"
import type { Prop } from "@automerge/automerge/slim"
import type { DocHandle } from "../DocHandle.js"
import type {
  DocumentChangePayload,
  DocumentEphemeralMessagePayload,
  DocumentHeadsChangedPayload,
  DocumentRemoteHeadsPayload,
  DocumentState,
} from "../DocumentState.js"
import { KIND } from "./types.js"
import type { PathSegment, Pattern } from "./types.js"
import { matchesPattern } from "./utils.js"

/**
 * Internal: centralised dispatcher + retention tracker for the sub-handles
 * belonging to a single root document.
 *
 * The registry is a trie-inspired index over the symbolic paths of
 * sub-handles that have at least one listener attached (retained). A patch
 * dispatch walks the trie from the root along the patch's path, gathering
 * terminals it passes through and BFS-expanding the subtree where the patch
 * terminates above a node. Pattern segments (`{ id: "x" }`) become a
 * separate set of edges at array-valued nodes; whenever a walk reaches an
 * array node with pattern edges, all of its patterns are re-resolved in a
 * single O(|array| x |unresolvedPatterns|) inverted-loop pass, memoised per
 * dispatch. The bulk-resolver also writes resolved indices back to each
 * retained sub-handle's own segment `.prop` field (edges track every
 * contributing segment) so that `value()`, `history()`, and external
 * observers of `ref.path[i].prop` stay accurate.
 *
 * Sub-handles that have never been retained (no listener ever attached) are
 * still tracked weakly in `DocumentState.handleCache`. They do not enter
 * the trie; instead they continue to receive `change` events through the
 * per-sub `_dispatchRootChange` forwarder, which refreshes their segment
 * `.prop` values via `#updatePropsFromRoot` - the same mechanism used
 * today. This keeps `ref.path[i].prop` observations well-defined on
 * listener-less refs without forcing them into the trie.
 *
 * Non-`change` events (`heads-changed`, `delete`, `remote-heads`,
 * `ephemeral-message`) are not path-filtered, so they iterate the live
 * sub-handle cache and call the sub's per-event forwarding method.
 */
export class SubHandleRegistry {
  /**
   * Subscribes to `DocumentState` events directly in the constructor so
   * the registry comes online as soon as the document exists, without a
   * separate "attach" step. The DocumentState constructor instantiates us
   * eagerly for the same reason.
   */
  constructor(private readonly state: DocumentState) {
    state.on("change", payload => this.dispatchChange(payload))
    state.on("heads-changed", payload => this.dispatchHeadsChanged(payload))
    state.on("delete", () => this.dispatchDelete())
    state.on("remote-heads", payload => this.dispatchRemoteHeads(payload))
    state.on("ephemeral-message", payload =>
      this.dispatchEphemeral(payload)
    )
  }

  #root: TrieNode = emptyNode()

  /**
   * Per-retained-sub bookkeeping: which terminal node it ends at, and which
   * (patternEdge, segment) pairs it contributes segments to. Used by
   * `remove()` to clean up in O(|path|) without re-walking.
   */
  #subRecords: Map<DocHandle<any>, SubRecord> = new Map()

  // ---------------- Retention + trie membership ----------------

  /**
   * Called when a sub-handle's listener count transitions from 0 to >=1.
   * Adds the sub to the strong-retainer set and installs it in the trie.
   */
  insert(sub: DocHandle<any>): void {
    this.state.subHandleRetainers.add(sub)
    if (this.#subRecords.has(sub)) return

    const segments = sub._pathSegments
    const patternContributions: PatternContribution[] = []

    let node = this.#root
    for (const seg of segments) {
      node = this.#descendForInsert(node, seg, patternContributions)
    }
    node.terminals.add(sub)
    this.#subRecords.set(sub, { terminal: node, patternContributions })
  }

  /**
   * Called when a sub-handle's listener count transitions to 0. Drops the
   * strong retainer and removes the sub's trie bookkeeping. (We intentionally
   * do not prune empty branches here: they're cheap to keep and likely to be
   * reused by the next `ref()` call at the same symbolic path.)
   */
  remove(sub: DocHandle<any>): void {
    this.state.subHandleRetainers.delete(sub)
    const record = this.#subRecords.get(sub)
    if (!record) return
    record.terminal.terminals.delete(sub)
    for (const { segment, edge } of record.patternContributions) {
      edge.segments.delete(segment)
    }
    this.#subRecords.delete(sub)
  }

  // ---------------- Dispatch ----------------

  /**
   * Fan out a root `change` event to every affected sub-handle.
   *
   * Retained subs receive their filtered patch list via a trie walk per
   * patch, with per-dispatch memoisation of pattern re-resolution. Dormant
   * subs (no listeners, not in the trie) continue through the legacy
   * per-sub dispatch path, which keeps their segment `.prop` values fresh
   * via `#updatePropsFromRoot`.
   */
  dispatchChange(payload: DocumentChangePayload): void {
    const perSubPatches = new Map<DocHandle<any>, A.Patch[]>()
    const resolvedNodes = new Set<TrieNode>()

    const doc = payload.doc

    for (const patch of payload.patches) {
      this.#collectForPatch(
        this.#root,
        patch.path,
        0,
        doc,
        patch,
        perSubPatches,
        resolvedNodes
      )
    }

    for (const [key, weak] of this.state.handleCache) {
      const sub = weak.deref()
      if (!sub) {
        this.state.handleCache.delete(key)
        continue
      }
      // Sub-handles pinned to fixed heads are frozen snapshots: their
      // value never changes as the live document moves forward, so we
      // suppress `change` emissions on them. Lifecycle and ephemeral
      // events still flow through (see dispatchDelete / dispatchEphemeral).
      if (sub.isReadOnly()) continue
      try {
        if (this.#subRecords.has(sub)) {
          const filtered = perSubPatches.get(sub)
          if (filtered && filtered.length > 0) {
            sub._emitFilteredChange(payload, filtered)
          }
        } else {
          // Dormant sub (no listeners). We still call the legacy per-sub
          // dispatch so its segment `.prop`s stay fresh for external
          // observers of `ref.path[i].prop`; the `emit` call at the end
          // is a no-op because there are no listeners.
          // TODO: replace this with lazy `.prop` refresh in `scopedValue`
          // - see the TODO on `DocHandle._dispatchRootChange`.
          sub._dispatchRootChange(payload)
        }
      } catch (e) {
        sub._log?.("error in sub-handle dispatch: %o", e)
      }
    }
  }

  dispatchHeadsChanged(payload: DocumentHeadsChangedPayload): void {
    this.#forEachLiveSubHandle(sub => {
      // Same reasoning as `dispatchChange`: a frozen sub-handle's heads
      // are fixed by definition and cannot change.
      if (sub.isReadOnly()) return
      sub._dispatchRootHeadsChanged(payload)
    })
  }

  dispatchDelete(): void {
    this.#forEachLiveSubHandle(sub => sub._dispatchRootDelete())
  }

  dispatchRemoteHeads(payload: DocumentRemoteHeadsPayload): void {
    this.#forEachLiveSubHandle(sub => sub._dispatchRootRemoteHeads(payload))
  }

  dispatchEphemeral(payload: DocumentEphemeralMessagePayload): void {
    this.#forEachLiveSubHandle(sub => sub._dispatchRootEphemeralMessage(payload))
  }

  // ---------------- Internals ----------------

  /**
   * Follow or create the trie edge for a single segment during insertion.
   *
   * Literal segments use the `children` map; pattern segments use the
   * `patternEdges` list, deduplicating by shallow pattern-equality so that
   * `handle.ref("tasks", {id:"x"})` and `handle.ref("tasks", {id:"x"}, "title")`
   * share the same pattern edge. The sub's own `segment` for a match kind
   * is recorded on the edge so that bulk-resolve can write the resolved
   * index back to every contributing segment (each sub has its own segment
   * instances even when they share the same pattern value).
   */
  #descendForInsert(
    node: TrieNode,
    seg: PathSegment,
    contributions: PatternContribution[]
  ): TrieNode {
    const kind = (seg as any)[KIND] as PathSegment[typeof KIND]
    if (kind === "key") {
      const key = (seg as any).key as string
      let child = node.children.get(key)
      if (!child) {
        child = emptyNode()
        node.children.set(key, child)
      }
      return child
    }
    if (kind === "index") {
      const idx = (seg as any).index as number
      let child = node.children.get(idx)
      if (!child) {
        child = emptyNode()
        node.children.set(idx, child)
      }
      return child
    }
    // kind === "match"
    const pattern = (seg as any).match as Pattern
    let edge: PatternEdge | undefined
    for (const existing of node.patternEdges) {
      if (patternsEqual(existing.pattern, pattern)) {
        edge = existing
        break
      }
    }
    if (!edge) {
      edge = {
        pattern,
        node: emptyNode(),
        segments: new Set(),
        resolvedIndex:
          typeof (seg as any).prop === "number"
            ? ((seg as any).prop as number)
            : undefined,
      }
      node.patternEdges.push(edge)
    }
    edge.segments.add(seg)
    contributions.push({ segment: seg, edge })
    return edge.node
  }

  /**
   * Walk the trie along a single patch's path, collecting terminals that
   * the patch affects. Bulk-resolves pattern edges at each array node the
   * walk actually visits, using the inverted-loop resolver below.
   */
  #collectForPatch(
    node: TrieNode,
    patchPath: readonly Prop[],
    i: number,
    cursor: unknown,
    patch: A.Patch,
    out: Map<DocHandle<any>, A.Patch[]>,
    resolvedNodes: Set<TrieNode>
  ): void {
    addPatchFor(node.terminals, patch, out)

    // If cursor is an array and we have pattern edges here, refresh their
    // resolvedIndex (and each contributing segment's .prop) in one pass.
    // Memoised per-dispatch.
    this.#maybeResolve(node, cursor, resolvedNodes)

    if (i >= patchPath.length) {
      // Patch terminates at or above this node. Fire all descendants.
      // Descendant pattern edges' indices stay as they were (descendant
      // arrays are below the patch path, so their contents didn't change).
      this.#collectDescendants(node, patch, out)
      return
    }

    const step = patchPath[i]

    const literalChild = node.children.get(step)
    if (literalChild) {
      const nextCursor = readStep(cursor, step)
      this.#collectForPatch(
        literalChild,
        patchPath,
        i + 1,
        nextCursor,
        patch,
        out,
        resolvedNodes
      )
    }

    if (node.patternEdges.length > 0) {
      const nextCursor = readStep(cursor, step)
      for (const edge of node.patternEdges) {
        if (edge.resolvedIndex !== undefined && edge.resolvedIndex === step) {
          this.#collectForPatch(
            edge.node,
            patchPath,
            i + 1,
            nextCursor,
            patch,
            out,
            resolvedNodes
          )
        }
      }
    }
  }

  /**
   * BFS over a node's descendants, adding every terminal's patch reference.
   * We don't re-resolve pattern edges during this walk: the patch did not
   * descend into those arrays, so their contents are unchanged and any
   * previously-cached resolvedIndex remains correct.
   */
  #collectDescendants(
    node: TrieNode,
    patch: A.Patch,
    out: Map<DocHandle<any>, A.Patch[]>
  ): void {
    const queue: TrieNode[] = []
    for (const child of node.children.values()) queue.push(child)
    for (const edge of node.patternEdges) queue.push(edge.node)
    while (queue.length > 0) {
      const current = queue.shift()!
      addPatchFor(current.terminals, patch, out)
      for (const child of current.children.values()) queue.push(child)
      for (const edge of current.patternEdges) queue.push(edge.node)
    }
  }

  /**
   * Inverted-loop bulk resolver for pattern edges at a single array node.
   *
   * Iterate the array once, carrying a set of as-yet-unresolved pattern
   * edges. For each item we check remaining patterns and, on a match,
   * record the index and remove the pattern from the working set. Early
   * exit when the set is empty. Unresolved patterns at the end of the pass
   * get `undefined` for their resolvedIndex (and contributing segment
   * `.prop` values).
   *
   * Cost per array: O(|array| x |unresolvedPatterns|) with early exit,
   * vs. today's O(|array| x |patterns|) per pattern (no sharing).
   */
  #maybeResolve(
    node: TrieNode,
    cursor: unknown,
    resolvedNodes: Set<TrieNode>
  ): void {
    if (node.patternEdges.length === 0) return
    if (!Array.isArray(cursor)) return
    if (resolvedNodes.has(node)) return
    resolvedNodes.add(node)

    const edges = node.patternEdges
    const unresolved = new Set<PatternEdge>()
    for (const edge of edges) {
      edge.resolvedIndex = undefined
      unresolved.add(edge)
    }

    for (let i = 0; i < cursor.length && unresolved.size > 0; i++) {
      const item = cursor[i]
      for (const edge of unresolved) {
        if (matchesPattern(item, edge.pattern)) {
          edge.resolvedIndex = i
          for (const seg of edge.segments) {
            ;(seg as any).prop = i
          }
          unresolved.delete(edge)
        }
      }
    }
    for (const edge of unresolved) {
      for (const seg of edge.segments) {
        ;(seg as any).prop = undefined
      }
    }
  }

  #forEachLiveSubHandle(fn: (sub: DocHandle<any>) => void): void {
    for (const [key, weak] of this.state.handleCache) {
      const sub = weak.deref()
      if (!sub) {
        this.state.handleCache.delete(key)
        continue
      }
      try {
        fn(sub)
      } catch (e) {
        sub._log?.("error in sub-handle dispatch: %o", e)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal data types + helpers
// ---------------------------------------------------------------------------

type TrieNode = {
  terminals: Set<DocHandle<any>>
  children: Map<Prop, TrieNode>
  patternEdges: PatternEdge[]
}

type PatternEdge = {
  pattern: Pattern
  node: TrieNode
  /**
   * Every segment instance from retained subs whose path passes through
   * this edge. Bulk-resolve writes back to each of them so any sub reading
   * `ref.path[i].prop` or `value()` sees fresh values.
   */
  segments: Set<PathSegment>
  resolvedIndex: number | undefined
}

type PatternContribution = {
  segment: PathSegment
  edge: PatternEdge
}

type SubRecord = {
  terminal: TrieNode
  patternContributions: PatternContribution[]
}

function emptyNode(): TrieNode {
  return { terminals: new Set(), children: new Map(), patternEdges: [] }
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

function readStep(cursor: unknown, step: Prop): unknown {
  if (cursor === null || cursor === undefined) return undefined
  return (cursor as any)[step as any]
}

function addPatchFor(
  subs: Set<DocHandle<any>>,
  patch: A.Patch,
  out: Map<DocHandle<any>, A.Patch[]>
): void {
  for (const sub of subs) {
    const existing = out.get(sub)
    if (existing) existing.push(patch)
    else out.set(sub, [patch])
  }
}
