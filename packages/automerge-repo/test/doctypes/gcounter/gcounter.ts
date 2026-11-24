import { defineDocType, type HandleKind } from "../../../src/DocType.js"
import { Handle } from "../../../src/Handle.js"
import {
  commit,
  emptyGraph,
  graphRules,
  type Graph,
} from "../common/commitGraph.js"

/**
 * A grow-only counter: each commit adds an amount, and the value is their
 * sum. Exercises the DocType interface without Automerge.
 */
export type CounterState = Graph<{ amount: number }>

export const add = (state: CounterState, amount: number): CounterState =>
  commit(state, { amount })

/** A new counter's state, starting at `start`. */
export const newCounter = (start = 0): CounterState => add(emptyGraph(), start)

/** A G-Counter's handle: reads the total, and changes it by an amount. */
export class CounterHandle extends Handle<number, number> {
  increment(amount = 1): Promise<void> {
    return this.change(amount)
  }
}

/** The G-Counter's handles; also the doc type's name:
 * `DocHandle<unknown, X, GCounter>`. */
export interface GCounter extends HandleKind {
  readonly handle: CounterHandle
}

export const gcounter = defineDocType({
  name: "gcounter",
  create: (start: number | undefined) => newCounter(start),
  value: (state: CounterState) =>
    [...state.applied.values()].reduce((n, c) => n + c.amount, 0),
  change: (state: CounterState, amount: number) => add(state, amount),
  ...graphRules<{ amount: number }>("gcounter"),
  handle: CounterHandle,
}).as<GCounter>()
