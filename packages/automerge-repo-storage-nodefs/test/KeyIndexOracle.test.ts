/**
 * Model-based oracle test for the adapter's prefix index.
 *
 * `loadRange` answers prefix queries from an incremental segment trie
 * (`keyIndex`) kept in lockstep with the flat `cache` object. Before the
 * trie, the same answer came from a linear scan:
 *
 *   Object.keys(this.cache).filter(k => k.startsWith(prefix))
 *
 * whose result order was object-insertion order. The trie must reproduce
 * that scan exactly — same result set (segment-boundary matching; real
 * storage keys are segment-prefix-free, and this test's vocabulary is
 * too) and same order, including the subtle cases:
 *
 *   - overwriting a key preserves its original position
 *   - delete + re-insert moves a key to the end
 *
 * The reference model here is that old scan, expressed over an
 * insertion-ordered Map (identical semantics for non-index string keys).
 * fast-check drives random op sequences (save / remove / removeRange)
 * against both the real adapter and the model, comparing every prefix
 * query after every op.
 */

import fc from "fast-check"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { NodeFSStorageAdapter } from "../src"

// ─── Vocabulary ───────────────────────────────────────────────────────
//
// Mirrors real storage keys: fixed-length shard ids, then a chunk-type
// segment, then a fixed-length hash. No segment is a string prefix of a
// sibling, so segment-boundary matching and the old string `startsWith`
// agree — the equivalence the production code relies on.

const IDS = ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC"] as const
const TYPES = ["snapshot", "incremental", "sync-state"] as const
const HASHES = ["h0", "h1", "h2"] as const

/** Every prefix the oracle checks after each operation. */
const QUERY_PREFIXES: string[][] = IDS.flatMap(id => [
  [id],
  ...TYPES.map(type => [id, type]),
])

// ─── Reference model: the old Object.keys scan ────────────────────────

const SEP = "\u0000"
const join = (key: string[]) => key.join(SEP)
const split = (key: string) => key.split(SEP)

const segmentsMatch = (key: string[], prefix: string[]): boolean =>
  prefix.length <= key.length && prefix.every((seg, i) => key[i] === seg)

class ReferenceModel {
  /** Insertion-ordered, like Object.keys on non-index string keys. */
  private entries = new Map<string, Uint8Array>()

  save(key: string[], value: Uint8Array): void {
    // Map.set preserves position on overwrite and appends when new —
    // exactly the old object-property semantics.
    this.entries.set(join(key), value)
  }

  remove(key: string[]): void {
    this.entries.delete(join(key))
  }

  removeRange(prefix: string[]): void {
    for (const k of [...this.entries.keys()]) {
      if (segmentsMatch(split(k), prefix)) this.entries.delete(k)
    }
  }

  loadRange(prefix: string[]): Array<{ key: string[]; data: Uint8Array }> {
    return [...this.entries]
      .filter(([k]) => segmentsMatch(split(k), prefix))
      .map(([k, data]) => ({ key: split(k), data }))
  }
}

// ─── Operation generators ─────────────────────────────────────────────

type Op =
  | { type: "save"; key: string[]; value: Uint8Array }
  | { type: "remove"; key: string[] }
  | { type: "removeRange"; prefix: string[] }

const keyArb = fc
  .tuple(
    fc.constantFrom(...IDS),
    fc.constantFrom(...TYPES),
    fc.constantFrom(...HASHES)
  )
  .map(segs => [...segs])

const bytesArb = fc.uint8Array({ minLength: 1, maxLength: 8 })

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      type: fc.constant("save" as const),
      key: keyArb,
      value: bytesArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ type: fc.constant("remove" as const), key: keyArb }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("removeRange" as const),
      prefix: fc.oneof(
        keyArb.map(k => k.slice(0, 1)),
        keyArb.map(k => k.slice(0, 2))
      ),
    }),
  }
)

// ─── The property ─────────────────────────────────────────────────────

describe("NodeFSStorageAdapter prefix-index oracle", () => {
  it("loadRange matches the reference Object.keys scan after any op sequence", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 1, maxLength: 15 }),
        async ops => {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nodefs-oracle-"))
          try {
            const adapter = new NodeFSStorageAdapter(dir)
            const model = new ReferenceModel()

            for (const op of ops) {
              switch (op.type) {
                case "save":
                  await adapter.save(op.key, op.value)
                  model.save(op.key, op.value)
                  break
                case "remove":
                  await adapter.remove(op.key)
                  model.remove(op.key)
                  break
                case "removeRange":
                  await adapter.removeRange(op.prefix)
                  model.removeRange(op.prefix)
                  break
              }

              // Compare every prefix query after every op, so a desync
              // can't be masked by a later removeRange.
              for (const prefix of QUERY_PREFIXES) {
                expect(await adapter.loadRange(prefix)).toStrictEqual(
                  model.loadRange(prefix)
                )
              }
            }
          } finally {
            fs.rmSync(dir, { force: true, recursive: true })
          }
        }
      ),
      { numRuns: 25 }
    )
  }, 120_000)
})
