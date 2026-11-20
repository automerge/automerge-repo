import * as A from "@automerge/automerge"
import { commitId, isBoundary } from "@automerge/automerge-repo/sedimentree"
import {
  changesIn,
  extractFragments,
} from "@automerge/automerge-repo/sedimentree/automerge"
import { expect, it } from "vitest"
import {
  contentRef,
  FragmentIndex,
  matchingChanges,
} from "../src/DocumentRefs.js"

const ref = (n: number) => contentRef(new Uint8Array(32).fill(n))
const commit = (prefix: string, fill: string) =>
  commitId(prefix + fill.repeat(32 - prefix.length / 2))

it("finds the deepest fragment containing a commit, among those included", () => {
  const inside = commit("", "11")
  const shallow = commit("00", "ab")
  const deep = commit("0000", "cd")
  const index = new FragmentIndex()
  index.add(ref(1), shallow, [shallow, inside])
  index.add(ref(2), deep, [deep, shallow, inside])

  expect(index.deepestContaining(inside)).toBe(ref(2))
  expect(index.deepestContaining(inside, r => r !== ref(2))).toBe(ref(1))
  expect(index.deepestContaining(commit("", "22"))).toBeUndefined()
})

it("accepts every fragment of a history with concurrent branches", () => {
  let a = A.init<{ n: number }>("aa".repeat(16))
  let b = A.clone(a, "bb".repeat(16))
  for (let i = 0; i < 3000; i++) {
    a = A.change(a, { time: 0 }, doc => void (doc.n = i))
    b = A.change(b, { time: 0 }, doc => void (doc.n = -i))
    if (i % 40 === 39) [a, b] = [A.merge(a, b), A.merge(b, a)]
  }
  const boundaries = A.getAllChanges(a)
    .map(change => commitId(A.decodeChange(change).hash))
    .filter(isBoundary)
  const { records } = extractFragments(a, boundaries)
  const depsDiffer = records.filter(fragment => {
    const deps = new Set(changesIn(fragment.blob)!.deps)
    return (
      fragment.kind === "fragment" &&
      (deps.size !== fragment.boundary.length ||
        fragment.boundary.some(id => !deps.has(id)))
    )
  })

  expect(depsDiffer.length).toBeGreaterThan(0)
  expect(records.filter(f => !matchingChanges(f, changesIn))).toEqual([])
})
