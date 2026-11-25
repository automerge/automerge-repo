import {
  defineDocType,
  Handle,
  type HandleKind,
} from "@automerge/automerge-repo"
import type {
  CommitId,
  RecordBatch,
} from "@automerge/automerge-repo/sedimentree"

/** A grow-only counter, a doc type other than Automerge: each commit adds
 * an amount, and the value is their sum. */
type Commit = { id: string; amount: number; parents: string[] }
type State = Map<string, Commit>

const newId = () =>
  (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "")
const encode = (c: Commit) => new TextEncoder().encode(JSON.stringify(c))
const headsOf = (state: State) => {
  const parents = new Set([...state.values()].flatMap(c => c.parents))
  return [...state.keys()].filter(id => !parents.has(id)).sort()
}
const ancestors = (state: State, heads: readonly string[]) => {
  const seen = new Set<string>()
  const stack = [...heads]
  while (stack.length) {
    const c = state.get(stack.pop()!)
    if (!c || seen.has(c.id)) continue
    seen.add(c.id)
    stack.push(...c.parents)
  }
  return seen
}
const add = (state: State, amount: number): State => {
  const c = { id: newId(), amount, parents: headsOf(state) }
  return new Map(state).set(c.id, c)
}

export class CounterHandle extends Handle<number, number> {
  increment(amount = 1): Promise<void> {
    return this.change(amount)
  }
}

export interface Counter extends HandleKind {
  readonly scheme: "counter"
  readonly handle: CounterHandle
}

export const counter = defineDocType({
  scheme: "counter",
  create: (start: number | undefined) => add(new Map(), start ?? 0),
  value: (state: State) =>
    [...state.values()].reduce((n, c) => n + c.amount, 0),
  change: (state: State, amount: number) => add(state, amount),
  apply: (state: State | undefined, records: RecordBatch): State => {
    const next = new Map(state)
    for (const record of records)
      if (record.kind === "commit") {
        const c: Commit = JSON.parse(new TextDecoder().decode(record.blob))
        next.set(c.id, c)
      }
    return next
  },
  heads: headsOf,
  hasHeads: (state: State, heads: readonly string[]) =>
    heads.every(h => state.has(h)),
  recordsSince: (state: State, heads: readonly string[]): RecordBatch =>
    [...state.values()]
      .filter(c => !ancestors(state, heads).has(c.id))
      .map(c => ({
        kind: "commit" as const,
        id: c.id as CommitId,
        parents: [...c.parents].sort() as CommitId[],
        blob: encode(c),
      })),
  handle: CounterHandle,
}).as<Counter>()
