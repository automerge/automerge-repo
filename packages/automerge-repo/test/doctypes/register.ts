import { defineDocType, type Shaped } from "../../src/DocType.js"
import { Handle } from "../../src/Handle.js"
import { commit, emptyGraph, graphRules, type Graph } from "./commitGraph.js"

/**
 * A last-writer-wins register holding a whole value of any shape: each
 * commit sets the value, and of concurrent heads the one with the greatest
 * ID wins. Its handles are generic in the value's shape, so it is
 * {@link Shaped}.
 */
export type RegisterState = Graph<{ value: unknown }>

const valueOf = (state: RegisterState): unknown => {
  const heads = graphRules<{ value: unknown }>("register").heads(state)
  return heads.length ? state.applied.get(heads.at(-1)!)!.value : undefined
}

/** A register's handle: the value, and a typed way to set one field of it. */
export class RegisterHandle<T> extends Handle<T, T> {
  get<K extends keyof T>(key: K): T[K] {
    return this.doc()[key]
  }

  set<K extends keyof T>(key: K, value: T[K]): Promise<void> {
    return this.change({ ...this.doc(), [key]: value })
  }
}

/** How a register's handles take a shape, and what `create` takes for it. */
interface RegisterShaped extends Shaped {
  readonly handle: RegisterHandle<this["T"]>
  readonly init: this["T"]
}

export const register = defineDocType({
  scheme: "register",
  create: (value: unknown): RegisterState => commit(emptyGraph(), { value }),
  value: valueOf,
  change: (state: RegisterState, value: unknown) => commit(state, { value }),
  ...graphRules<{ value: unknown }>("register"),
  handle: RegisterHandle,
}).shaped<RegisterShaped>()
