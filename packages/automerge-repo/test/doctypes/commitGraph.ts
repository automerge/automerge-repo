import { createHash } from "node:crypto"
import type {
  CommitId,
  LooseCommitRecord,
  RecordBatch,
} from "../../src/sedimentree/index.js"

/**
 * A commit graph in plain JS, shared by the test doc types: each commit
 * carries a payload `P`, is identified by the sha256 of its JSON, and is
 * stored as one loose commit. Immutable; no fragments.
 */
export type Commit<P> = P & { parents: string[]; nonce: string }

export interface Graph<P> {
  readonly applied: ReadonlyMap<string, Commit<P>>
  /** Received commits whose parents are not all applied yet. */
  readonly pending: ReadonlyMap<string, Commit<P>>
}

const encode = (commit: Commit<unknown>) =>
  new TextEncoder().encode(JSON.stringify(commit))
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

export const emptyGraph = <P>(): Graph<P> => ({
  applied: new Map(),
  pending: new Map(),
})

export function headsOf<P>(graph: Graph<P>): string[] {
  const parents = new Set([...graph.applied.values()].flatMap(c => c.parents))
  return [...graph.applied.keys()].filter(id => !parents.has(id)).sort()
}

/** A new commit on top of the current heads. */
export function commit<P>(graph: Graph<P>, payload: P): Graph<P> {
  const next = {
    ...payload,
    parents: headsOf(graph),
    nonce: crypto.randomUUID(),
  } as Commit<P>
  const applied = new Map(graph.applied)
  applied.set(hash(encode(next)), next)
  return { applied, pending: graph.pending }
}

/** Move pending commits whose parents are applied, to a fixed point. */
function settle<P>(
  applied: Map<string, Commit<P>>,
  pending: Map<string, Commit<P>>
): void {
  let progress = true
  while (progress) {
    progress = false
    for (const [id, c] of pending)
      if (c.parents.every(p => applied.has(p))) {
        applied.set(id, c)
        pending.delete(id)
        progress = true
      }
  }
}

function ancestors<P>(graph: Graph<P>, heads: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const stack = [...heads]
  while (stack.length) {
    const id = stack.pop()!
    const c = graph.applied.get(id)
    if (!c || seen.has(id)) continue
    seen.add(id)
    stack.push(...c.parents)
  }
  return seen
}

/** The storage half of a doc type over a commit graph. */
export const graphRules = <P>(scheme: string) => ({
  apply(graph: Graph<P> | undefined, records: RecordBatch): Graph<P> {
    const applied = new Map(graph?.applied)
    const pending = new Map(graph?.pending)
    for (const record of records) {
      if (record.kind !== "commit")
        throw new Error(`${scheme} has no fragments`)
      const c = JSON.parse(new TextDecoder().decode(record.blob))
      if (!applied.has(record.id)) pending.set(record.id, c)
    }
    settle(applied, pending)
    return { applied, pending }
  },
  heads: (graph: Graph<P>) => headsOf(graph),
  hasHeads: (graph: Graph<P>, heads: readonly string[]) =>
    heads.every(h => graph.applied.has(h)),
  recordsSince(graph: Graph<P>, heads: readonly string[]): RecordBatch {
    const known = ancestors(graph, heads)
    const out: LooseCommitRecord[] = []
    for (const [id, c] of graph.applied)
      if (!known.has(id))
        out.push({
          kind: "commit",
          id: id as CommitId,
          parents: [...c.parents].sort() as CommitId[],
          blob: encode(c),
        })
    return out
  },
  view(graph: Graph<P>, heads: readonly string[]): Graph<P> {
    const keep = ancestors(graph, heads)
    return {
      applied: new Map([...graph.applied].filter(([id]) => keep.has(id))),
      pending: new Map(),
    }
  },
})
