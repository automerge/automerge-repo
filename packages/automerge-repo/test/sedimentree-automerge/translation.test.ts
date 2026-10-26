// @vitest-environment node
// Like Repo's test setup, load fullfat once; library code imports only slim.
import "@automerge/automerge"
import * as A from "@automerge/automerge/slim"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  checkpointForCommit,
  commitId,
  type CommitId,
  type FragmentRecord,
  type LooseCommitRecord,
  type SedimentreeRecord,
} from "../../src/sedimentree/index.js"
import {
  applyRecords,
  extractFragments,
  extractRecords,
  extractNewCommits,
  satisfiesMarker,
} from "../../src/sedimentree/automerge/index.js"

// Externalized native ESM namespaces are sealed. A forwarding mock gives spies
// configurable properties without replacing Automerge behavior or initialization.
vi.mock("@automerge/automerge/slim", async importOriginal => ({
  ...(await importOriginal<typeof A>()),
}))

type State = { n: number; local?: boolean }
let fixture: A.Doc<State>
let records: SedimentreeRecord[]
let changes: Uint8Array[]
let commits: LooseCommitRecord[]

function loose(blob: Uint8Array): LooseCommitRecord {
  const decoded = A.decodeChange(blob)
  return {
    kind: "commit",
    id: commitId(decoded.hash),
    parents: decoded.deps.map(commitId).sort(),
    blob,
  }
}

function empty(actor = "112233"): A.Doc<State> {
  return A.init<State>({ actor })
}

beforeAll(() => {
  fixture = empty("abcdef")
  for (let n = 0; n < 2000; n++) {
    fixture = A.change(fixture, { time: 0 }, doc => {
      doc.n = n
    })
  }
  records = extractRecords(fixture)
  changes = A.getAllChanges(fixture)
  commits = changes.map(loose)
}, 30_000)

afterEach(() => vi.restoreAllMocks())

describe("metadata-first extraction", () => {
  it("rebuilds both arrival orders of concurrent level-1 and level-2 fragments from covering records", () => {
    // Three fixed actors: F is level 1; H (level 1) and K (level 2)
    // independently descend from F. Their hash prefixes are part of the fixture.
    const [f, k, h] = [
      "856f4a8300779194010a0001aa0101b002000000",
      "856f4a8300001334012b01007791944ed174f20cb0268401fab1528d20835916d604b0a0fe591eb690ad2201bb0101de8a01000000",
      "856f4a8300619aad012a01007791944ed174f20cb0268401fab1528d20835916d604b0a0fe591eb690ad2201cc0101fd02000000",
    ].map(hex => new Uint8Array(Buffer.from(hex, "hex")))
    const ids = [f, k, h].map(blob => A.decodeChange(blob).hash)
    expect(ids[0].startsWith("00")).toBe(true)
    expect(ids[1].startsWith("0000")).toBe(true)
    expect(ids[2].startsWith("00")).toBe(true)
    for (const order of [
      [f, h, k],
      [f, k, h],
    ]) {
      let doc = empty()
      for (const blob of order) [doc] = A.applyChanges(doc, [blob])
      const metadata = A.getFragmentMetadata(doc)
      const deeper = metadata.find(meta => meta.head === ids[1])
      const sibling = metadata.find(meta => meta.head === ids[2])
      expect(deeper?.level).toBe(2)
      expect(deeper?.members).toContain(ids[0])
      expect(sibling?.level).toBe(1)
      expect(sibling?.boundary).toEqual(order[1] === h ? [ids[0]] : [])
      const covering = extractRecords(doc)
      expect(
        covering.some(r => r.kind === "fragment" && r.head === ids[1])
      ).toBe(true)
      // Earlier fragments may wait for later records supplying their boundary.
      const restored = covering.reduce(
        (loaded, record) => applyRecords(loaded, [record]),
        empty()
      )
      expect(A.getHeads(restored)).toEqual(A.getHeads(doc))
      expect(A.getMissingDeps(restored)).toEqual([])
      expect(
        A.getAllChanges(restored)
          .map(blob => A.decodeChange(blob).hash)
          .sort()
      ).toEqual([...ids].sort())
    }
  })

  it("extracts ordinary changes as loose commits without re-bundling history", () => {
    expect(commits[1].id.startsWith("00")).toBe(false)
    const [before] = A.applyChanges(empty("abcdef"), [changes[0]])
    const [after] = A.applyChanges(A.clone(before), [changes[1]])
    const changesSince = vi.spyOn(A, "getChangesSince")
    const metadata = vi.spyOn(A, "getFragmentMetadata")
    const bundle = vi.spyOn(A, "bundleFragmentMetadata")
    const delta = extractNewCommits(before, after)
    expect(changesSince).toHaveBeenCalledWith(after, A.getHeads(before))
    expect(metadata).not.toHaveBeenCalled()
    expect(bundle).not.toHaveBeenCalled()
    expect(delta.every(record => record.kind === "commit")).toBe(true)
    expect(delta.map(record => record.blob)).toEqual(
      A.getChanges(before, after)
    )
    expect(applyRecords(A.clone(before), delta)).toEqual(after)
    expect(extractNewCommits(after, after)).toEqual([])
  })

  it("extracts boundary changes as loose commits too, without scanning fragments", () => {
    const boundary = commits.findIndex(commit => commit.id.startsWith("00"))
    expect(boundary).toBeGreaterThan(0)
    const [prior] = A.applyChanges(empty("abcdef"), changes.slice(0, boundary))
    const [after] = A.applyChanges(
      A.clone(prior),
      changes.slice(boundary, boundary + 3)
    )
    const metadata = vi.spyOn(A, "getFragmentMetadata")
    const delta = extractNewCommits(prior, after)
    expect(metadata).not.toHaveBeenCalled()
    expect(delta.map(record => record.id)).toEqual(
      commits.slice(boundary, boundary + 3).map(commit => commit.id)
    )
    expect(applyRecords(A.clone(prior), delta)).toEqual(after)
  })

  it("bundles fragments by head with one lookup each, reporting heads without one", () => {
    const boundary = commits.findIndex(commit => commit.id.startsWith("00"))
    const [after] = A.applyChanges(
      empty("abcdef"),
      changes.slice(0, boundary + 1)
    )
    const head = commits[boundary].id
    const loose = commits[boundary - 1].id
    const scan = vi.spyOn(A, "getFragmentMetadata")
    const lookup = vi.spyOn(A, "getFragmentMeta")
    const { records: fragments, absent } = extractFragments(after, [
      head,
      loose,
    ])
    expect(scan).not.toHaveBeenCalled()
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(fragments.map(record => record.head)).toEqual([head])
    expect(absent).toEqual([loose])
    // Bundled with the commits stored earlier, the fragment rebuilds the doc.
    expect(
      applyRecords(empty(), [...commits.slice(0, boundary + 1), ...fragments])
    ).toEqual(after)
    expect(applyRecords(empty(), fragments)).toEqual(after)
  })

  it("covers 2000 deterministic changes with fragments and loose commits", () => {
    expect(changes).toHaveLength(2000)
    expect(changes.every(change => A.decodeChange(change).time === 0)).toBe(
      true
    )
    expect(
      changes.every(change => A.decodeChange(change).actor === "abcdef")
    ).toBe(true)
    expect(records.some(record => record.kind === "commit")).toBe(true)
    expect(records.some(record => record.kind === "fragment")).toBe(true)
    const metadata = A.getFragmentMetadata(fixture)
    expect(new Set(metadata.flatMap(meta => meta.members)).size).toBe(2000)
    metadata.forEach((meta, index) => {
      const record = records[index]
      if (record.kind === "fragment") {
        expect(record.head).toBe(meta.head)
        expect(record.boundary).toEqual([...new Set(meta.boundary)].sort())
        expect(record.checkpoints).toEqual(
          [
            ...new Set(
              meta.checkpoints.map(hash => checkpointForCommit(commitId(hash)))
            ),
          ].sort()
        )
        expect(record.checkpoints.every(prefix => prefix.length === 24)).toBe(
          true
        )
      } else {
        expect(record.id).toBe(meta.head)
        expect(record.parents).toEqual([...new Set(meta.boundary)].sort())
      }
    })
  })

  it("excludes heads and boundaries from fragment checkpoints while retaining heads in members", () => {
    // Regression for Automerge 3.5.0: 3.3.2 included the head in checkpoints.
    const metadata = A.getFragmentMetadata(fixture).filter(
      meta => meta.level > 0
    )
    const bundled = A.getFragments(fixture)
    expect(metadata.length).toBeGreaterThan(0)
    expect(bundled).toHaveLength(metadata.length)
    for (const fragment of [...metadata, ...bundled]) {
      expect(fragment.members).toContain(fragment.head)
      const excluded = new Set([fragment.head, ...fragment.boundary])
      expect(fragment.checkpoints.some(hash => excluded.has(hash))).toBe(false)
      expect(A.getFragmentMeta(fixture, fragment.head)?.checkpoints).toEqual(
        fragment.checkpoints
      )
    }
  })

  it("bundles all metadata in one call without decoding history", () => {
    const getMetadata = vi.spyOn(A, "getFragmentMetadata")
    const bundle = vi.spyOn(A, "bundleFragmentMetadata")
    const decode = vi.spyOn(A, "decodeChange")
    const readBundle = vi.spyOn(A, "readBundle")
    const getFragments = vi.spyOn(A, "getFragments")
    const getAllChanges = vi.spyOn(A, "getAllChanges")
    expect(extractRecords(fixture)).toEqual(records)
    expect(getMetadata).toHaveBeenCalledOnce()
    expect(bundle).toHaveBeenCalledOnce()
    expect(bundle.mock.calls[0][1]).toHaveLength(records.length)
    expect(decode).not.toHaveBeenCalled()
    expect(readBundle).not.toHaveBeenCalled()
    expect(getFragments).not.toHaveBeenCalled()
    expect(getAllChanges).not.toHaveBeenCalled()
  })

  it("does not expose borrowed output buffers", () => {
    const first = extractRecords(fixture)
    first[0].blob.fill(0)
    const second = extractRecords(fixture)
    expect(second[0].blob).toEqual(records[0].blob)
    expect(first[0].blob).not.toEqual(second[0].blob)
    expect(A.getHeads(fixture)).toEqual([commits.at(-1)!.id])
  })
})

describe("incremental application", () => {
  it("roundtrips mixed records, in reverse order and with duplicate batches", () => {
    let loaded = applyRecords(empty(), [...records].reverse())
    expect(loaded.n).toBe(1999)
    expect(A.getHeads(loaded)).toEqual(A.getHeads(fixture))
    const before = A.getHeads(loaded)
    loaded = applyRecords(loaded, records)
    loaded = applyRecords(loaded, [...records, ...records])
    expect(A.getHeads(loaded)).toEqual(before)
    expect(loaded.n).toBe(1999)
  })

  it("roundtrips a forked history with multiple document heads", () => {
    let left = A.clone(fixture, { actor: "aabbcc" })
    let right = A.clone(fixture, { actor: "ccbbaa" })
    for (let n = 2000; n < 2250; n++) {
      left = A.change(left, { time: 0 }, doc => {
        doc.n = n
      })
      right = A.change(right, { time: 0 }, doc => {
        doc.local = n % 2 === 0
      })
    }
    const merged = A.merge(left, right)
    expect(A.getHeads(merged)).toHaveLength(2)
    const loaded = applyRecords(empty(), extractRecords(merged).reverse())
    expect(A.getHeads(loaded)).toEqual(A.getHeads(merged))
    expect(loaded).toEqual(merged)
  })

  it("roundtrips repeatedly merged histories whose boundaries omit some direct dependencies", () => {
    const docs = ["aabbcc", "ddeeff"].map(actor =>
      A.init<Record<string, number>>({ actor })
    )
    for (let i = 0; i < 200; i++) {
      const side = i % 2
      docs[side] = A.change(docs[side], { time: 0 }, draft => {
        draft[`x${side}`] = i
      })
      if (i % 5 === 0) docs[side] = A.merge(docs[side], docs[1 - side])
    }
    const merged = A.merge(docs[0], docs[1])
    const batch = extractRecords(merged)
    expect(
      batch.some(
        record =>
          record.kind === "fragment" &&
          A.readBundle(record.blob).deps.some(
            dep => !record.boundary.includes(commitId(dep))
          )
      )
    ).toBe(true)
    const loaded = applyRecords(A.init(), batch.reverse())
    expect(loaded).toEqual(merged)
    expect(A.getHeads(loaded)).toEqual(A.getHeads(merged))
  })

  it("roundtrips all 2000 loose commits without fragments", () => {
    const loaded = applyRecords(empty(), [...commits].reverse())
    expect(loaded.n).toBe(1999)
    expect(A.getHeads(loaded)).toEqual(A.getHeads(fixture))
  })

  it("retains out-of-order loose changes across empty batches and intervening local edits", () => {
    let loaded = applyRecords(empty(), [commits[2]])
    expect(A.getHeads(loaded)).toEqual([])
    expect(A.getMissingDeps(loaded, [])).toContain(commits[1].id)
    expect(satisfiesMarker(loaded, [commits[2].id])).toBe(false)
    expect(applyRecords(loaded, [])).toBe(loaded)
    loaded = applyRecords(loaded, [commits[0]])
    loaded = A.change(loaded, { time: 0 }, doc => {
      doc.local = true
    })
    loaded = applyRecords(loaded, [commits[1]])
    expect(loaded.n).toBe(2)
    expect(loaded.local).toBe(true)
    expect(satisfiesMarker(loaded, [commits[2].id])).toBe(true)
  })

  it("retains a pending fragment while later batches and local edits arrive", () => {
    const partial = records.find(
      record => record.kind === "fragment" && record.boundary.length > 0
    ) as FragmentRecord
    let loaded = applyRecords(empty(), [partial])
    expect(A.getHeads(loaded)).toEqual([])
    expect(A.getMissingDeps(loaded, []).length).toBeGreaterThan(0)
    expect(satisfiesMarker(loaded, [partial.head])).toBe(false)
    loaded = A.change(loaded, { time: 0 }, doc => {
      doc.local = true
    })
    loaded = applyRecords(
      loaded,
      records.filter(record => record !== partial)
    )
    expect(loaded.n).toBe(1999)
    expect(loaded.local).toBe(true)
    expect(satisfiesMarker(loaded, [partial.head])).toBe(true)
    expect(A.getMissingDeps(loaded, [])).toEqual([])
  })

  it("owns input bytes, including Buffer and subarray inputs, even when pending", () => {
    const parent = new Uint8Array(commits[2].blob.length + 20)
    parent.set(commits[2].blob, 10)
    const bytes = parent.subarray(10, parent.length - 10)
    const input = { ...commits[2], blob: bytes }
    let loaded = applyRecords(empty(), [input])
    parent.fill(0)
    loaded = applyRecords(loaded, commits.slice(0, 2))
    expect(loaded.n).toBe(2)
    const buffer = Buffer.from(commits[2].blob)
    const bufferRecord = { ...commits[2], blob: buffer }
    let buffered = applyRecords(empty("445566"), [bufferRecord])
    buffer.fill(0)
    buffered = applyRecords(buffered, commits.slice(0, 2))
    expect(buffered.n).toBe(2)
  })
})

describe("source marker satisfaction", () => {
  it("uses historical inclusion with newer local edits, not head equality", () => {
    let loaded = applyRecords(empty(), records)
    const historical = A.getHeads(loaded).map(commitId)
    loaded = A.change(loaded, { time: 0 }, doc => {
      doc.local = true
    })
    expect(A.getHeads(loaded)).not.toEqual(historical)
    expect(satisfiesMarker(loaded, historical)).toBe(true)
    expect(satisfiesMarker(loaded, [commits[0].id])).toBe(true)
    expect(satisfiesMarker(loaded, [commitId("ff".repeat(32))])).toBe(false)
    expect(
      satisfiesMarker(loaded, [commits[0].id, commitId("ff".repeat(32))])
    ).toBe(false)
  })

  it("rejects empty readiness proofs even on nonempty documents", () => {
    expect(satisfiesMarker(empty(), [])).toBe(false)
    expect(satisfiesMarker(fixture, [])).toBe(false)
    expect(() => satisfiesMarker(fixture, ["bad" as CommitId])).toThrow()
  })

  it("satisfies one complete source despite unrelated pending dependencies", () => {
    let unrelated = empty("ddccbb")
    unrelated = A.change(unrelated, { time: 0 }, doc => {
      doc.local = false
    })
    unrelated = A.change(unrelated, { time: 0 }, doc => {
      doc.local = true
    })
    const last = loose(A.getLastLocalChange(unrelated)!)
    let loaded = applyRecords(empty(), [last, commits[0]])
    expect(A.getMissingDeps(loaded, [])).toEqual(last.parents)
    expect(satisfiesMarker(loaded, [commits[0].id])).toBe(true)
    expect(satisfiesMarker(loaded, [last.id])).toBe(false)
    loaded = applyRecords(loaded, [loose(A.getAllChanges(unrelated)[0])])
    expect(loaded.local).toBe(true)
    expect(satisfiesMarker(loaded, [last.id])).toBe(true)
  })
})
