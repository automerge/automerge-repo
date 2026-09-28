import { expect } from "vitest"
import type { SedimentreeEvent } from "../../src/sedimentree/backend.js"
import {
  checkpointId,
  commitId,
  sedimentreeId,
  type CommitId,
} from "../../src/sedimentree/ids.js"
import type {
  FragmentRecord,
  LooseCommitRecord,
} from "../../src/sedimentree/records.js"

export const treeId = (n = 1) => sedimentreeId(n.toString(16).padStart(32, "0"))
export const cid = (n: number) => commitId(n.toString(16).padStart(64, "0"))
export const commit = (
  n: number,
  parents: CommitId[] = [],
  blob = new Uint8Array([n])
): LooseCommitRecord => ({ kind: "commit", id: cid(n), parents, blob })
export const fragment = (n: number): FragmentRecord => ({
  kind: "fragment",
  head: cid(n),
  boundary: [cid(n - 1)],
  checkpoints: [checkpointId("ab".repeat(12))],
  blob: new Uint8Array([n, 0]),
})

/** No wall-clock races or indefinitely awaited next(): this double is synchronous.
 * A future asynchronous backend can supply a scheduler-aware equivalent. */
export async function settled<T>(promise: Promise<T>): Promise<T> {
  let state: { value: T } | { error: unknown } | undefined
  void promise.then(
    value => {
      state = { value }
    },
    error => {
      state = { error }
    }
  )
  for (let i = 0; i < 20 && !state; i++) await Promise.resolve()
  expect(state, "operation should settle without timers/network").toBeDefined()
  if (!state) throw new Error("Operation did not settle")
  if ("error" in state) throw state.error
  return state.value
}

export async function next<T>(iterator: AsyncIterator<T>): Promise<T> {
  const result = await settled(iterator.next())
  expect(result.done).not.toBe(true)
  return result.value
}

export async function event<K extends SedimentreeEvent["type"]>(
  iterator: AsyncIterator<SedimentreeEvent>,
  type: K
): Promise<Extract<SedimentreeEvent, { type: K }>> {
  const value = await next(iterator)
  expect(value.type).toBe(type)
  return value as Extract<SedimentreeEvent, { type: K }>
}

export async function initial(iterator: AsyncIterator<SedimentreeEvent>) {
  const records = []
  for (let i = 0; i < 100; i++) {
    const value = await next(iterator)
    if (value.type === "local-load-complete")
      return { records, complete: value }
    expect(value.type).toBe("records")
    if (value.type !== "records") throw new Error("Unexpected initial event")
    expect(value.phase).toBe("initial")
    records.push(...value.records)
  }
  throw new Error("Initial enumeration did not terminate")
}

export async function expectPending(promise: Promise<unknown>) {
  let done = false
  void promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    }
  )
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(done).toBe(false)
}
