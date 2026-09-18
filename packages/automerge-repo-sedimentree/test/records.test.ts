import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { checkpointId, type CommitId } from "../src/ids.js"
import {
  copyRecord,
  equalRecords,
  recordBytes,
  recordHead,
  recordKey,
  type SedimentreeRecord,
} from "../src/records.js"
import { cid, commit, fragment } from "./helpers.js"

describe("plain record validation and ownership", () => {
  it.each(["Uint8Array", "Buffer"])(
    "owns blob bytes from %s, in both directions",
    kind => {
      const storage =
        kind === "Buffer"
          ? Buffer.from([0, 1, 2, 3])
          : new Uint8Array([0, 1, 2, 3])
      const input = commit(1, [cid(2)], storage.subarray(1, 3))
      const copied = copyRecord(input)
      expect(copied.blob).toEqual(new Uint8Array([1, 2]))
      storage[1] = 99
      expect(copied.blob[0]).toBe(1)
      copied.blob[1] = 88
      expect(storage[2]).toBe(2)
      expect(copied).not.toBe(input)
      expect(copied.kind === "commit" && copied.parents).not.toBe(input.parents)
    }
  )

  it("canonicalizes parents, boundary and checkpoints as independent sorted sets", () => {
    const high = "AB".repeat(32) as CommitId
    const low = cid(2)
    const parents = [high, low, high.toLowerCase() as CommitId]
    const input = commit(1, parents)
    const copied = copyRecord(input)
    expect(copied).toMatchObject({ parents: [low, high.toLowerCase()] })
    expect(parents).toEqual([high, low, high.toLowerCase()])
    parents.length = 0
    expect(copied).toMatchObject({ parents: [low, high.toLowerCase()] })
    const checkpoints = [
      checkpointId("ff".repeat(12)),
      checkpointId("ab".repeat(12)),
      checkpointId("ff".repeat(12)),
    ]
    const boundary = [high, low, high]
    const f = copyRecord({ ...fragment(4), boundary, checkpoints })
    expect(f).toMatchObject({
      boundary: [low, high.toLowerCase()],
      checkpoints: ["ab".repeat(12), "ff".repeat(12)],
    })
    boundary.length = checkpoints.length = 0
    expect(f.kind === "fragment" && f.boundary).toHaveLength(2)
    expect(f.kind === "fragment" && f.checkpoints).toHaveLength(2)
  })

  it("distinguishes logical kind/head keys from exact representation equality", () => {
    const c = commit(5)
    const f = fragment(5)
    expect(recordHead(c)).toBe(recordHead(f))
    expect(recordKey(c)).not.toBe(recordKey(f))
    expect(equalRecords(c, copyRecord(c))).toBe(true)
    expect(equalRecords(c, f)).toBe(false)
    expect(equalRecords(c, { ...c, blob: new Uint8Array([6]) })).toBe(false)
    expect(equalRecords(c, { ...c, parents: [cid(1)] })).toBe(false)
    expect(equalRecords(f, { ...f, boundary: [] })).toBe(false)
    expect(equalRecords(f, { ...f, checkpoints: [] })).toBe(false)
  })

  it("counts payload and metadata bytes, not just the blob", () => {
    expect(recordBytes(commit(1, [cid(2), cid(3)], new Uint8Array(7)))).toBe(
      7 + 32 + 64
    )
    expect(recordBytes(fragment(5))).toBe(2 + 32 + 32 + 12)
  })

  it.each([
    { ...commit(1), blob: new Uint8Array() },
    { ...commit(1), blob: [1] },
    { ...commit(1), parents: [cid(1)] },
    { ...commit(1), parents: ["bad"] },
    { ...commit(1), id: "bad" },
    { ...fragment(2), head: "bad" },
    { ...fragment(2), boundary: ["bad"] },
    { ...fragment(2), checkpoints: [cid(2)] },
    { ...commit(1), kind: "unknown" },
  ])("rejects invalid record %#", record => {
    expect(() => copyRecord(record as SedimentreeRecord)).toThrow(TypeError)
  })
})
