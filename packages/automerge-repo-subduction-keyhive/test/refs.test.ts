import {
  checkpointForCommit,
  commitId,
} from "@automerge/automerge-repo/sedimentree"
import { expect, it } from "vitest"
import { contentRef, FragmentIndex } from "../src/DocumentRefs.js"

const ref = (n: number) => contentRef(new Uint8Array(32).fill(n))
const commit = (prefix: string, fill: string) =>
  commitId(prefix + fill.repeat(32 - prefix.length / 2))

it("finds the deepest fragment with a commit as head or checkpoint", () => {
  const inside = commit("00", "11")
  const shallow = commit("00", "ab")
  const deep = commit("0000", "cd")
  const index = new FragmentIndex()
  index.add(ref(1), {
    head: shallow,
    checkpoints: [checkpointForCommit(inside)],
  })
  index.add(ref(2), {
    head: deep,
    checkpoints: [shallow, inside].map(checkpointForCommit),
  })

  expect(index.deepestContaining(inside)).toBe(ref(2))
  expect(index.deepestContaining(shallow)).toBe(ref(2))
  expect(index.deepestContaining(inside, r => r !== ref(2))).toBe(ref(1))
  expect(index.deepestContaining(commit("", "22"))).toBeUndefined()
})
