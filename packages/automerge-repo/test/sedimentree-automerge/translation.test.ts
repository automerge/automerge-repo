// @vitest-environment node
// Like Repo's test setup, load fullfat once; library code imports only slim.
import "@automerge/automerge"
import { deflateRawSync } from "node:zlib"
import * as A from "@automerge/automerge/slim"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  checkpointForCommit,
  checkpointId,
  commitId,
  equalRecords,
  recordKey,
  type CommitId,
  type FragmentRecord,
  type LooseCommitRecord,
  type SedimentreeRecord,
} from "../../src/sedimentree/index.js"
import {
  applyRecords,
  extractRecords,
  extractNewRecords,
  getRecordMetadata,
  recordMetadataKey,
  satisfiesCheckpoint,
  validateRecord,
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
  it("extracts ordinary changes directly without re-bundling history", () => {
    expect(commits[1].id.startsWith("00")).toBe(false)
    const [before] = A.applyChanges(empty("abcdef"), [changes[0]])
    const [after] = A.applyChanges(A.clone(before), [changes[1]])
    const changesSince = vi.spyOn(A, "getChangesSince")
    const metadata = vi.spyOn(A, "getFragmentMetadata")
    const bundle = vi.spyOn(A, "bundleFragmentMetadata")
    const delta = extractNewRecords(before, after)
    expect(changesSince).toHaveBeenCalledWith(after, A.getHeads(before))
    expect(metadata).not.toHaveBeenCalled()
    expect(bundle).not.toHaveBeenCalled()
    expect(delta.every(record => record.kind === "commit")).toBe(true)
    expect(delta.map(record => record.blob)).toEqual(
      A.getChanges(before, after)
    )
    expect(applyRecords(A.clone(before), delta)).toEqual(after)
    expect(extractNewRecords(after, after)).toEqual([])
  })

  it("writes new fragment representations at boundaries", () => {
    const boundary = commits.findIndex(commit => commit.id.startsWith("00"))
    expect(boundary).toBeGreaterThan(0)
    const [prior] = A.applyChanges(empty("abcdef"), changes.slice(0, boundary))
    const [after] = A.applyChanges(A.clone(prior), [changes[boundary]])
    const delta = extractNewRecords(prior, after)
    expect(delta.some(record => record.kind === "fragment")).toBe(true)
    expect(delta.some(record => record.kind === "commit")).toBe(false)
    expect(applyRecords(A.clone(prior), delta)).toEqual(after)
    // Previously persisted history and the boundary delta suffice after restart.
    expect(applyRecords(empty(), [...extractRecords(prior), ...delta])).toEqual(
      after
    )
  })

  it("writes a boundary and subsequent loose changes from one update", () => {
    const boundary = commits.findIndex(commit => commit.id.startsWith("00"))
    expect(boundary).toBeGreaterThan(0)
    expect(
      commits
        .slice(boundary + 1, boundary + 3)
        .every(commit => !commit.id.startsWith("00"))
    ).toBe(true)
    const [prior] = A.applyChanges(empty("abcdef"), changes.slice(0, boundary))
    const [after] = A.applyChanges(
      A.clone(prior),
      changes.slice(boundary, boundary + 3)
    )
    const delta = extractNewRecords(prior, after)
    expect(delta.map(record => record.kind)).toEqual([
      "fragment",
      "commit",
      "commit",
    ])
    expect(applyRecords(empty(), [...extractRecords(prior), ...delta])).toEqual(
      after
    )
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
    expect(records.map(recordMetadataKey)).toEqual(
      getRecordMetadata(fixture).map(recordMetadataKey)
    )
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

  it("inspects without bundling; bundles only selected native metadata", () => {
    const getMetadata = vi.spyOn(A, "getFragmentMetadata")
    const bundle = vi.spyOn(A, "bundleFragmentMetadata")
    const decode = vi.spyOn(A, "decodeChange")
    const readBundle = vi.spyOn(A, "readBundle")
    const getFragments = vi.spyOn(A, "getFragments")
    const getAllChanges = vi.spyOn(A, "getAllChanges")
    const metadata = getRecordMetadata(fixture)
    expect(bundle).not.toHaveBeenCalled()
    const wanted = new Set([
      recordMetadataKey(metadata[0]),
      recordMetadataKey(metadata.at(-1)!),
    ])
    const selected = extractRecords(fixture, meta =>
      wanted.has(recordMetadataKey(meta))
    )
    expect(getMetadata).toHaveBeenCalledTimes(2)
    expect(bundle).toHaveBeenCalledTimes(1)
    expect(bundle.mock.calls[0][1]).toHaveLength(2)
    expect(selected.map(recordMetadataKey)).toEqual([...wanted])
    expect(
      selected.every(record =>
        records.some(original => equalRecords(record, original))
      )
    ).toBe(true)
    expect(decode).not.toHaveBeenCalled()
    expect(readBundle).not.toHaveBeenCalled()
    expect(getFragments).not.toHaveBeenCalled()
    expect(getAllChanges).not.toHaveBeenCalled()
    expect(extractRecords(fixture, () => false)).toEqual([])
    expect(bundle).toHaveBeenCalledTimes(1)
  })

  it("keeps full metadata distinct from the logical head key and bytes", () => {
    const fragment = records.find(
      record => record.kind === "fragment"
    ) as FragmentRecord
    const variant = { ...fragment, boundary: [commitId("ff".repeat(32))] }
    expect(recordKey(variant)).toBe(recordKey(fragment))
    expect(recordMetadataKey(variant)).not.toBe(recordMetadataKey(fragment))
    expect(equalRecords(variant, fragment)).toBe(false)
    const otherBytes = { ...fragment, blob: new Uint8Array([1]) }
    expect(recordMetadataKey(otherBytes)).toBe(recordMetadataKey(fragment))
    expect(equalRecords(otherBytes, fragment)).toBe(false)
    expect(
      recordMetadataKey({
        ...variant,
        boundary: [...variant.boundary, ...variant.boundary],
      })
    ).toBe(recordMetadataKey(variant))
  })

  it("does not expose mutable native metadata or borrowed output buffers", () => {
    const metadata = getRecordMetadata(fixture)
    expect(Object.isFrozen(metadata[0])).toBe(true)
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
    let loaded = applyRecords(empty(), [...records].reverse(), {
      maxBatchBytes: 8192,
      maxBatchRecords: 7,
    })
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
    const loaded = applyRecords(empty(), [...commits].reverse(), {
      maxBatchBytes: 16384,
    })
    expect(loaded.n).toBe(1999)
    expect(A.getHeads(loaded)).toEqual(A.getHeads(fixture))
  })

  it("bounds concatenation, loads an oversized single record alone, and batches mixed kinds", () => {
    const load = vi.spyOn(A, "loadIncremental")
    const maxBatchBytes = 2048
    applyRecords(empty(), records, { maxBatchBytes, maxBatchRecords: 4 })
    expect(load.mock.calls.length).toBeLessThan(records.length)
    for (const [, input] of load.mock.calls) {
      expect(
        input.length <= maxBatchBytes ||
          records.some(
            record =>
              record.blob.length > maxBatchBytes &&
              record.blob.length === input.length
          )
      ).toBe(true)
    }
    load.mockClear()
    applyRecords(empty(), records, {
      maxBatchBytes: 10_000_000,
      maxBatchRecords: 10_000,
    })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("retains out-of-order loose changes across empty batches and intervening local edits", () => {
    let loaded = applyRecords(empty(), [commits[2]])
    expect(A.getHeads(loaded)).toEqual([])
    expect(A.getMissingDeps(loaded, [])).toContain(commits[1].id)
    expect(satisfiesCheckpoint(loaded, [commits[2].id])).toBe(false)
    expect(applyRecords(loaded, [])).toBe(loaded)
    loaded = applyRecords(loaded, [commits[0]])
    loaded = A.change(loaded, { time: 0 }, doc => {
      doc.local = true
    })
    loaded = applyRecords(loaded, [commits[1]])
    expect(loaded.n).toBe(2)
    expect(loaded.local).toBe(true)
    expect(satisfiesCheckpoint(loaded, [commits[2].id])).toBe(true)
  })

  it("retains a pending fragment while later batches and local edits arrive", () => {
    const partial = records.find(
      record => record.kind === "fragment" && record.boundary.length > 0
    ) as FragmentRecord
    let loaded = applyRecords(empty(), [partial])
    expect(A.getHeads(loaded)).toEqual([])
    expect(A.getMissingDeps(loaded, []).length).toBeGreaterThan(0)
    expect(satisfiesCheckpoint(loaded, [partial.head])).toBe(false)
    loaded = A.change(loaded, { time: 0 }, doc => {
      doc.local = true
    })
    loaded = applyRecords(
      loaded,
      records.filter(record => record !== partial)
    )
    expect(loaded.n).toBe(1999)
    expect(loaded.local).toBe(true)
    expect(satisfiesCheckpoint(loaded, [partial.head])).toBe(true)
    expect(A.getMissingDeps(loaded, [])).toEqual([])
  })

  it("owns input bytes, including Buffer and subarray inputs, even when pending", () => {
    const parent = new Uint8Array(commits[2].blob.length + 20)
    parent.set(commits[2].blob, 10)
    const bytes = parent.subarray(10, parent.length - 10)
    const input = { ...commits[2], blob: bytes }
    const validated = validateRecord(input)
    let loaded = applyRecords(empty(), [input])
    parent.fill(0)
    expect(validated.blob).toEqual(commits[2].blob)
    loaded = applyRecords(loaded, commits.slice(0, 2))
    expect(loaded.n).toBe(2)
    const buffer = Buffer.from(commits[2].blob)
    const bufferRecord = { ...commits[2], blob: buffer }
    const owned = validateRecord(bufferRecord)
    let buffered = applyRecords(empty("445566"), [bufferRecord])
    buffer.fill(0)
    expect(owned.blob).toEqual(commits[2].blob)
    buffered = applyRecords(buffered, commits.slice(0, 2))
    expect(buffered.n).toBe(2)
  })
})

describe("source checkpoint satisfaction", () => {
  it("uses historical inclusion with newer local edits, not head equality", () => {
    let loaded = applyRecords(empty(), records)
    const historical = A.getHeads(loaded).map(commitId)
    loaded = A.change(loaded, { time: 0 }, doc => {
      doc.local = true
    })
    expect(A.getHeads(loaded)).not.toEqual(historical)
    expect(satisfiesCheckpoint(loaded, historical)).toBe(true)
    expect(satisfiesCheckpoint(loaded, [commits[0].id])).toBe(true)
    expect(satisfiesCheckpoint(loaded, [commitId("ff".repeat(32))])).toBe(false)
    expect(
      satisfiesCheckpoint(loaded, [commits[0].id, commitId("ff".repeat(32))])
    ).toBe(false)
  })

  it("rejects empty readiness proofs even on nonempty documents", () => {
    expect(satisfiesCheckpoint(empty(), [])).toBe(false)
    expect(satisfiesCheckpoint(fixture, [])).toBe(false)
    expect(() => satisfiesCheckpoint(fixture, ["bad" as CommitId])).toThrow()
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
    expect(satisfiesCheckpoint(loaded, [commits[0].id])).toBe(true)
    expect(satisfiesCheckpoint(loaded, [last.id])).toBe(false)
    loaded = applyRecords(loaded, [loose(A.getAllChanges(unrelated)[0])])
    expect(loaded.local).toBe(true)
    expect(satisfiesCheckpoint(loaded, [last.id])).toBe(true)
  })
})

describe("payload and metadata validation", () => {
  it("checks loose hashes and parents against encoded changes, even for known heads", () => {
    expect(() =>
      validateRecord({ ...commits[1], id: commitId("ff".repeat(32)) })
    ).toThrow(/metadata/)
    expect(() => validateRecord({ ...commits[1], parents: [] })).toThrow(
      /metadata/
    )
    expect(() =>
      validateRecord({ ...commits[1], parents: [commits[1].id] })
    ).toThrow()
    const loaded = applyRecords(empty(), commits.slice(0, 2))
    expect(() =>
      applyRecords(loaded, [{ ...commits[1], blob: commits[0].blob }])
    ).toThrow(/metadata/)
    expect(
      validateRecord({
        ...commits[1],
        parents: [...commits[1].parents, ...commits[1].parents],
      })
    ).toEqual(commits[1])
  })

  it("checks fragment tips and checkpoint membership without inferring boundary coverage", () => {
    const fragment = records.find(
      record => record.kind === "fragment" && record.boundary.length
    ) as FragmentRecord
    expect(validateRecord(fragment)).toEqual(fragment)
    expect(() =>
      validateRecord({ ...fragment, head: commitId("ff".repeat(32)) })
    ).toThrow(/head/)
    expect(() =>
      validateRecord({
        ...fragment,
        checkpoints: [checkpointId("ff".repeat(12))],
      })
    ).toThrow(/checkpoint/)
    // Extra old boundary ancestors are legitimate; exact bundle deps equality
    // is NOT a sound check of sedimentree boundary metadata.
    const extraBoundary = records.find(
      record =>
        record.kind === "fragment" &&
        record.boundary.length > A.readBundle(record.blob).deps.length
    )!
    expect(extraBoundary).toBeDefined()
    expect(validateRecord(extraBoundary)).toEqual(extraBoundary)
  })

  it("rejects trailing chunks that readBundle alone silently ignores", () => {
    const fragment = records.find(
      record => record.kind === "fragment"
    ) as FragmentRecord
    const blob = new Uint8Array(
      fragment.blob.length + commits.at(-1)!.blob.length
    )
    blob.set(fragment.blob)
    blob.set(commits.at(-1)!.blob, fragment.blob.length)
    expect(A.readBundle(blob).changes.length).toBeGreaterThan(0)
    expect(() => validateRecord({ ...fragment, blob })).toThrow(/exactly one/)
    expect(() =>
      validateRecord({ ...fragment, blob: fragment.blob.subarray(0, -1) })
    ).toThrow()
    const corrupt = fragment.blob.slice()
    corrupt[4] ^= 0xff
    expect(() =>
      applyRecords(empty(), [{ ...fragment, blob: corrupt }])
    ).toThrow()
  })

  it.each(["commit", "fragment"] as const)(
    "rejects corrupt %s checksums anywhere in a batch before changing the document",
    kind => {
      const good =
        kind === "commit"
          ? commits[1]
          : records.find(record => record.kind === "fragment")!
      const blob = good.blob.slice()
      blob[4] ^= 0xff
      const corrupt = { ...good, blob }
      expect(() => validateRecord(corrupt)).toThrow(/checksum/)
      for (const original of [empty(), applyRecords(empty(), [commits[0]])]) {
        const before = A.getHeads(original)
        for (const batch of [
          [corrupt, commits[2]],
          [commits[0], corrupt, commits[2]],
          [commits[0], commits[2], corrupt],
        ]) {
          expect(() => applyRecords(original, batch)).toThrow(/checksum/)
          expect(A.getHeads(original)).toEqual(before)
        }
      }
    }
  )

  it("validates compressed changes using their uncompressed checksum", () => {
    const raw = commits[0].blob
    expect(raw[8]).toBe(1)
    let start = 9
    while (raw[start++] & 0x80) {
      /* skip ULEB payload length */
    }
    const compressed = deflateRawSync(raw.subarray(start))
    let size = compressed.length
    const length = []
    do {
      const byte = size % 128
      size = Math.floor(size / 128)
      length.push(byte | (size ? 0x80 : 0))
    } while (size)
    const blob = Uint8Array.from([
      ...raw.subarray(0, 8),
      2,
      ...length,
      ...compressed,
    ])
    const record = { ...commits[0], blob }
    expect(validateRecord(record)).toEqual(record)
    expect(
      satisfiesCheckpoint(applyRecords(empty(), [record]), [record.id])
    ).toBe(true)
    blob[4] ^= 0xff
    expect(() => validateRecord(record)).toThrow(/checksum/)
  })

  it("rejects trailing chunks on a loose commit as well as fragments", () => {
    const blob = Uint8Array.from([...commits[0].blob, ...commits[1].blob])
    expect(() => validateRecord({ ...commits[0], blob })).toThrow(/exactly one/)
  })

  it("does not skip an invalid fragment representation just because its head is known", () => {
    const fragment = records.find(
      record => record.kind === "fragment"
    ) as FragmentRecord
    const loaded = applyRecords(empty(), records)
    expect(() =>
      applyRecords(loaded, [
        { ...fragment, checkpoints: [checkpointId("ff".repeat(12))] },
      ])
    ).toThrow(/checkpoint/)
  })

  it("rejects malformed IDs, checkpoint lengths, payloads and limits before loading", () => {
    const load = vi.spyOn(A, "loadIncremental")
    const fragment = records.find(
      record => record.kind === "fragment"
    ) as FragmentRecord
    const malformed: SedimentreeRecord[] = [
      { ...commits[0], id: "zz" as CommitId },
      { ...commits[0], parents: ["ab" as CommitId] },
      { ...commits[0], blob: new Uint8Array() },
      { ...commits[0], blob: new Uint8Array([1, 2, 3]) },
      { ...fragment, head: "abc" as CommitId },
      { ...fragment, boundary: ["gg".repeat(32) as CommitId] },
      {
        ...fragment,
        checkpoints: [
          fragment.head as unknown as ReturnType<typeof checkpointId>,
        ],
      },
      { ...fragment, blob: commits[0].blob },
    ]
    for (const record of malformed) {
      expect(() => applyRecords(empty(), [commits[0], record])).toThrow()
    }
    for (const limit of [0, -1, 1.5, NaN, Infinity]) {
      expect(() =>
        applyRecords(empty(), records, { maxBatchBytes: limit })
      ).toThrow(RangeError)
      expect(() =>
        applyRecords(empty(), records, { maxBatchRecords: limit })
      ).toThrow(RangeError)
    }
    expect(load).not.toHaveBeenCalled()
  })
})
