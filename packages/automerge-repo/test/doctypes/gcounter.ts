import { createHash } from "node:crypto"
import { defineDocType } from "../../src/DocType.js"
import { Handle, type CoreHandleEvents } from "../../src/Handle.js"
import type { HandleExtensionSpec } from "../../src/sedimentree/extension.js"
import type {
  CommitId,
  LooseCommitRecord,
  RecordBatch,
} from "../../src/sedimentree/index.js"

/**
 * A grow-only counter: each commit adds an amount, and the value is their
 * sum. Immutable state, plain JS, no fragments. Exercises the DocType
 * interface without Automerge.
 */
interface Commit {
  parents: string[]
  amount: number
  nonce: string
}

export interface CounterState {
  readonly applied: ReadonlyMap<string, Commit>
  /** Received commits whose parents are not all applied yet. */
  readonly pending: ReadonlyMap<string, Commit>
}

const encode = (commit: Commit) =>
  new TextEncoder().encode(JSON.stringify(commit))
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

function headsOf(applied: ReadonlyMap<string, Commit>): string[] {
  const parents = new Set([...applied.values()].flatMap(c => c.parents))
  return [...applied.keys()].filter(id => !parents.has(id)).sort()
}

export function add(state: CounterState, amount: number): CounterState {
  const commit = {
    parents: headsOf(state.applied),
    amount,
    nonce: crypto.randomUUID(),
  }
  const applied = new Map(state.applied)
  applied.set(hash(encode(commit)), commit)
  return { applied, pending: state.pending }
}

/** Move pending commits whose parents are applied, to a fixed point. */
function settle(
  applied: Map<string, Commit>,
  pending: Map<string, Commit>
): void {
  let progress = true
  while (progress) {
    progress = false
    for (const [id, commit] of pending)
      if (commit.parents.every(p => applied.has(p))) {
        applied.set(id, commit)
        pending.delete(id)
        progress = true
      }
  }
}

function ancestors(state: CounterState, heads: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const stack = [...heads]
  while (stack.length) {
    const id = stack.pop()!
    const commit = state.applied.get(id)
    if (!commit || seen.has(id)) continue
    seen.add(id)
    stack.push(...commit.parents)
  }
  return seen
}

/** A G-Counter's handle: reads the total, and changes it by an amount. */
export class CounterHandle<X extends HandleExtensionSpec = {}> extends Handle<
  CounterState,
  X,
  CoreHandleEvents<number>
> {
  override doc(): number {
    return super.doc() as number
  }

  override change(amount: number): Promise<void> {
    return super.change(amount)
  }

  increment(amount = 1): Promise<void> {
    return this.change(amount)
  }
}

const empty: CounterState = { applied: new Map(), pending: new Map() }

/** A new counter's state, starting at `start`. */
export const newCounter = (start = 0): CounterState => add(empty, start)

export const gcounter = defineDocType({
  scheme: "gcounter",
  create: (start: number | undefined) => newCounter(start),
  value: (state: CounterState) =>
    [...state.applied.values()].reduce((n, c) => n + c.amount, 0),
  change: (state: CounterState, amount: number) => add(state, amount),
  apply(state: CounterState | undefined, records: RecordBatch) {
    const applied = new Map(state?.applied)
    const pending = new Map(state?.pending)
    for (const record of records) {
      if (record.kind !== "commit") throw new Error("gcounter has no fragments")
      const commit = JSON.parse(new TextDecoder().decode(record.blob))
      if (!applied.has(record.id)) pending.set(record.id, commit)
    }
    settle(applied, pending)
    return { applied, pending }
  },
  heads: state => headsOf(state.applied),
  hasHeads: (state, heads) => heads.every(h => state.applied.has(h)),
  recordsSince(state, heads) {
    const known = ancestors(state, heads)
    const out: LooseCommitRecord[] = []
    for (const [id, commit] of state.applied)
      if (!known.has(id))
        out.push({
          kind: "commit",
          id: id as CommitId,
          parents: [...commit.parents].sort() as CommitId[],
          blob: encode(commit),
        })
    return out
  },
  view(state, heads) {
    const keep = ancestors(state, heads)
    return {
      applied: new Map([...state.applied].filter(([id]) => keep.has(id))),
      pending: new Map(),
    }
  },
  handle: CounterHandle,
})
