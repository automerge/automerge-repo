import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runStorageAdapterTests } from "../../automerge-repo/src/helpers/tests/storage-adapter-tests"
import { NodeFSStorageAdapter } from "../src"

describe("NodeFSStorageAdapter", () => {
  const setup = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automerge-repo-tests"))
    const teardown = () => {
      fs.rmSync(dir, { force: true, recursive: true })
    }
    const adapter = new NodeFSStorageAdapter(dir)
    return { adapter, teardown }
  }

  runStorageAdapterTests(setup)

  // ─── Atomicity / durability ──────────────────────────────────────────
  //
  // The shared acceptance tests don't cover the write-to-temp + rename
  // atomic write pattern. These tests verify that no temporary artefacts
  // leak into loadRange results, that saveBatch persists every entry,
  // and that overwriting an existing key leaves the on-disk file in one
  // of the two valid states (old value or new value) rather than a
  // partial mix.

  describe("atomic writes", () => {
    let dir: string
    let adapter: NodeFSStorageAdapter

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "nodefs-atomic-"))
      adapter = new NodeFSStorageAdapter(dir)
    })

    afterEach(() => {
      fs.rmSync(dir, { force: true, recursive: true })
    })

    it("does not leave .tmp files behind after a successful save", async () => {
      const key = ["AAAAAAAA", "snapshot", "hash"]
      await adapter.save(key, new Uint8Array([1, 2, 3, 4]))

      const leftover = walkSync(dir).filter(f =>
        path.basename(f).includes(".tmp.")
      )
      expect(leftover).toHaveLength(0)
    })

    it("overwriting a key leaves either the old or new value, never a partial mix", async () => {
      const key = ["AAAAAAAA", "snapshot", "hash"]

      // 64 KiB so a torn write would be visibly shorter on disk
      const v1 = new Uint8Array(64 * 1024).fill(0xaa)
      const v2 = new Uint8Array(64 * 1024).fill(0xbb)

      await adapter.save(key, v1)
      await adapter.save(key, v2)

      const loaded = await adapter.load(key)
      expect(loaded).toBeDefined()
      expect(loaded!.length).toBe(v2.length)
      expect(loaded!.every(b => b === 0xbb)).toBe(true)
    })

    it("saveBatch persists every entry", async () => {
      const entries: Array<[string[], Uint8Array]> = []
      for (let i = 0; i < 32; i++) {
        const hash = i.toString(16).padStart(8, "0")
        entries.push([
          ["AAAAAAAA", "incremental", hash],
          new Uint8Array([i, i, i, i]),
        ])
      }

      await adapter.saveBatch(entries)

      for (const [key, expected] of entries) {
        const loaded = await adapter.load(key)
        expect(loaded).toBeDefined()
        expect(Array.from(loaded!)).toEqual(Array.from(expected))
      }
    })

    it("saveBatch([]) is a no-op", async () => {
      await adapter.saveBatch([])
      // Nothing to assert beyond "didn't throw" — but confirm directory
      // is still empty so we didn't accidentally create anything.
      const files = walkSync(dir)
      expect(files).toHaveLength(0)
    })

    it("concurrent saves to the same key converge to exactly one written value", async () => {
      const key = ["AAAAAAAA", "snapshot", "hash"]
      const values = Array.from({ length: 16 }, (_, i) =>
        new Uint8Array(1024).fill(i)
      )

      await Promise.all(values.map(v => adapter.save(key, v)))

      const loaded = await adapter.load(key)
      expect(loaded).toBeDefined()
      expect(loaded!.length).toBe(1024)
      // Must be fully one of the written values, never a mix.
      const firstByte = loaded![0]
      expect(loaded!.every(b => b === firstByte)).toBe(true)
      expect(values.some(v => v[0] === firstByte)).toBe(true)
    })

    it("loadRange ignores in-flight .tmp files left over from a crashed write", async () => {
      const key = ["AAAAAAAA", "snapshot", "hash"]
      await adapter.save(key, new Uint8Array([1, 2, 3, 4]))

      // Simulate a concurrent atomic write that crashed mid-flight by
      // dropping a stray .tmp file next to the real one.
      const realFile = walkSync(dir).find(
        f => !path.basename(f).includes(".tmp.")
      )!
      const staleTmp = `${realFile}.tmp.99999.deadbeef`
      fs.writeFileSync(staleTmp, Buffer.from([0xff, 0xff, 0xff, 0xff]))

      const chunks = await adapter.loadRange(["AAAAAAAA"])
      expect(chunks).toHaveLength(1)
      expect(Array.from(chunks[0].data!)).toEqual([1, 2, 3, 4])
    })
  })
})

/** Recursively walk a directory and return absolute paths of every file. */
function walkSync(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkSync(p))
    else out.push(p)
  }
  return out
}
