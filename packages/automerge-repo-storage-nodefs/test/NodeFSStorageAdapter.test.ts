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
  // leak into loadRange results and that overwriting an existing key
  // leaves the on-disk file in one of the two valid states (old value
  // or new value) rather than a partial mix.

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

      // Tmp files land in <baseDirectory>/.tmp/; after a successful save
      // the rename moves them out, so that directory must be empty. The
      // directory itself should exist (we created it lazily on first
      // write) but contain zero entries.
      const tmpDir = path.join(dir, ".tmp")
      expect(fs.existsSync(tmpDir)).toBe(true)
      expect(fs.readdirSync(tmpDir)).toEqual([])
    })

    it("sequentially overwriting a key yields the new value with no partial mix", async () => {
      const key = ["AAAAAAAA", "snapshot", "hash"]

      // 64 KiB so a torn write would be visibly shorter on disk
      const v1 = new Uint8Array(64 * 1024).fill(0xaa)
      const v2 = new Uint8Array(64 * 1024).fill(0xbb)

      await adapter.save(key, v1)
      await adapter.save(key, v2)

      // Read via a fresh adapter instance so we hit the on-disk bytes
      // rather than the writer's in-memory cache. This is what exercises
      // the atomic rename path.
      const fresh = new NodeFSStorageAdapter(dir)
      const loaded = await fresh.load(key)
      expect(loaded).toBeDefined()
      expect(loaded!.length).toBe(v2.length)
      expect(loaded!.every(b => b === 0xbb)).toBe(true)
    })

    it("concurrent saves to the same key converge to exactly one written value", async () => {
      const key = ["AAAAAAAA", "snapshot", "hash"]
      const values = Array.from({ length: 16 }, (_, i) =>
        new Uint8Array(1024).fill(i)
      )

      await Promise.all(values.map(v => adapter.save(key, v)))

      // Read via a fresh adapter instance so we observe on-disk state
      // rather than the writer's in-memory cache. The file must be
      // fully one of the written values, never a torn mix.
      const fresh = new NodeFSStorageAdapter(dir)
      const loaded = await fresh.load(key)
      expect(loaded).toBeDefined()
      expect(loaded!.length).toBe(1024)
      const firstByte = loaded![0]
      expect(loaded!.every(b => b === firstByte)).toBe(true)
      expect(values.some(v => v[0] === firstByte)).toBe(true)
    })

    it("loadRange is unaffected by a legitimate key whose basename contains .tmp.", async () => {
      // Regression guard against future additions of a tmp-file filter
      // in loadRange: a key whose trailing segment happens to contain
      // ".tmp." in the middle must remain visible. Current code doesn't
      // filter anything in loadRange (tmp files live under
      // <baseDirectory>/.tmp/ which walkdir skips), so this test is
      // defensive against regressions that re-introduce filtering.
      const weirdKey = ["AAAAAAAA", "blobs", "file.tmp.data"]
      await adapter.save(weirdKey, new Uint8Array([7, 7, 7]))

      const chunks = await adapter.loadRange(["AAAAAAAA"])
      const keyStrings = chunks.map(c => c.key.join("/"))
      expect(keyStrings).toContain(weirdKey.join("/"))
    })

    // ─── Cache rollback on failure ─────────────────────────────────────
    //
    // The adapter populates its in-memory cache synchronously so that
    // fire-and-forget saves are observable within the same process. If
    // the on-disk write subsequently fails, the cache must roll back so
    // it never exposes bytes that aren't durable on disk.

    it("save() rolls the cache back to the prior value on write failure", async () => {
      const key = ["AAAAAAAA", "snapshot", "hash"]
      await adapter.save(key, new Uint8Array([1, 1, 1]))

      // Force the next write to fail by dropping a regular file where
      // the nested shard directory would need to exist for a different
      // key. More reliable: drop a regular file where this key's own
      // parent directory would be recreated after a remove. Easiest
      // reliable approach: point a FRESH key at a path under a pre-
      // existing file-not-directory.
      const blockerKey = ["BBBBBBBB", "snapshot", "hash"]
      const adapterAny = adapter as unknown as {
        getFilePath(k: string[]): string
      }
      const blockerParent = path.dirname(adapterAny.getFilePath(blockerKey))
      // Make the intended directory path a plain file so mkdir fails.
      fs.mkdirSync(path.dirname(blockerParent), { recursive: true })
      fs.writeFileSync(blockerParent, Buffer.from("block"))

      await expect(
        adapter.save(blockerKey, new Uint8Array([9, 9, 9]))
      ).rejects.toBeDefined()

      // Cache must not report the failed key as having any value.
      expect(await adapter.load(blockerKey)).toBeUndefined()

      // A previously-saved key's cache must be untouched.
      const prior = await adapter.load(key)
      expect(prior).toBeDefined()
      expect(Array.from(prior!)).toEqual([1, 1, 1])
    })

    it("save() restores the prior cache value when overwriting an existing key fails", async () => {
      const key = ["AAAAAAAA", "snapshot", "hash"]
      await adapter.save(key, new Uint8Array([1, 1, 1]))

      // Clobber the parent directory's *file entry* for this key with a
      // directory so the next rename over it fails.
      const adapterAny = adapter as unknown as {
        getFilePath(k: string[]): string
      }
      const existingFile = adapterAny.getFilePath(key)
      fs.rmSync(existingFile)
      fs.mkdirSync(existingFile) // now a directory where a file should be

      await expect(
        adapter.save(key, new Uint8Array([2, 2, 2]))
      ).rejects.toBeDefined()

      // Cache should have rolled back to the original bytes (1,1,1),
      // NOT the attempted (2,2,2). load() consults the cache first, so
      // if we rolled back correctly we get [1,1,1].
      const loaded = await adapter.load(key)
      expect(loaded).toBeDefined()
      expect(Array.from(loaded!)).toEqual([1, 1, 1])
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
