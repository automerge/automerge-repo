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
 * belonging to a single document.
 *
 * Trie-indexed by symbolic paths of *retained* sub-handles (those with at
 * least one listener attached). A patch dispatch walks the trie from the
 * root along the patch's path, gathering terminals it passes through and
 * BFS-expanding the subtree where the patch terminates above a node.
 *
 * Pattern segments (`{ id: "x" }`) live as a separate set of edges at
 * array-valued nodes. When a walk reaches an array node with pattern
 * edges, all of its patterns are re-resolved in a single
 * O(|array| × |unresolvedPatterns|) inverted-loop pass, memoised per
 * dispatch. The bulk-resolver writes resolved indices back to each
 * contributing segment so observers of `ref.path[i].prop` see fresh
 * values.
 *
 * Sub-handles with no listeners are not tracked here at all (they live in
 * `DocumentState.handleCache` for identity only). Their `segment.prop`
 * values are refreshed lazily by `scopedValue` / `applyScopedChange` /
 * `applyScopedRemove` on first read after a change.
 *
 * All five document events (`change`, `heads-changed`, `delete`,
 * `remote-heads`, `ephemeral-message`) dispatch only to retained
 * sub-handles: a sub-handle with zero listeners is by definition
 * uninterested in events.
 */
export class SubHandleRegistry {
  /**
   * Subscribes to all five `DocumentState` events. `DocumentState`
   * instantiates the registry eagerly so dispatch is wired up the moment
   * the document exists.
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
   * Fan out a document-level `change` event to every retained sub-handle.
   * Walks the trie once per patch, memoising pattern re-resolution per
   * dispatch, then emits a filtered patch list on each affected sub-handle.
   * Frozen (fixed-heads) sub-handles are skipped: their content can't
   * change so they have nothing to fire.
   */
  dispatchChange(payload: DocumentChangePayload): void {
    const perSubPatches = new Map<DocHandle<any>, A.Patch[]>()
    const resolvedNodes = new Set<TrieNode>()

    for (const patch of payload.patches) {
      this.#collectForPatch(
        this.#root,
        patch.path,
        0,
        payload.doc,
        patch,
        perSubPatches,
        resolvedNodes
      )
    }

    for (const sub of this.state.subHandleRetainers) {
      if (sub.isReadOnly()) continue
      const filtered = perSubPatches.get(sub)
      if (!filtered || filtered.length === 0) continue
      try {
        sub._emitFilteredChange(payload, filtered)
      } catch (e) {
        sub._log?.("error in sub-handle dispatch: %o", e)
      }
    }
  }

  dispatchHeadsChanged(payload: DocumentHeadsChangedPayload): void {
    this.#forEachRetainedSubHandle(sub => {
      if (sub.isReadOnly()) return
      sub._dispatchRootHeadsChanged(payload)
    })
  }

  dispatchDelete(): void {
    this.#forEachRetainedSubHandle(sub => sub._dispatchRootDelete())
  }

  dispatchRemoteHeads(payload: DocumentRemoteHeadsPayload): void {
    this.#forEachRetainedSubHandle(sub =>
      sub._dispatchRootRemoteHeads(payload)
    )
  }

  dispatchEphemeral(payload: DocumentEphemeralMessagePayload): void {
    this.#forEachRetainedSubHandle(sub =>
      sub._dispatchRootEphemeralMessage(payload)
    )
  }

  // ---------------- Internals ----------------

  /**
   * Follow or create the trie edge for a single segment during insertion.
   * Literal segments key into `children`; pattern segments key into
   * `patternEdges` (linear search by shallow pattern equality), so refs
   * with the same pattern share an edge. Each sub's own `match`-kind
   * `segment` is recorded on the shared edge so bulk-resolve can write
   * resolved indices back to every contributing segment instance.
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
   * Walk the trie along one patch's path, collecting affected terminals.
   * Refreshes pattern edges (via `#maybeResolve`) at each array node the
   * walk visits.
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
    this.#maybeResolve(node, cursor, resolvedNodes)

    if (i >= patchPath.length) {
      // Patch terminates at or above this node. Everything below is
      // affected; descendant pattern indices stay valid because their
      // arrays weren't touched.
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
   * BFS over a node's descendants, adding every terminal to `out`. Does
   * not re-resolve pattern edges; descendant arrays weren't touched by
   * this patch, so their cached resolvedIndex values are still valid.
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
   * Iterates the array once, carrying a set of as-yet-unresolved pattern
   * edges. For each item, checks remaining patterns and on a match
   * records the index and drops the pattern from the working set. Early-
   * exits when the set is empty. Unresolved patterns at the end get
   * `undefined` for their resolvedIndex (and their contributing segment
   * `.prop` values).
   *
   * Cost per array: O(|array| × |unresolvedPatterns|) with early exit.
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

  /** Iterate retained sub-handles. Dormant ones have no listeners. */
  #forEachRetainedSubHandle(fn: (sub: DocHandle<any>) => void): void {
    for (const sub of this.state.subHandleRetainers) {
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
   * Every `match`-kind segment instance from retained subs that pass
   * through this edge. Bulk-resolve writes the resolved index back to
   * each of them so observers of `ref.path[i].prop` see fresh values.
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
