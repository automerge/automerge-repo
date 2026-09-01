import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest"
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

    // ─── Cache lifetime on failure ─────────────────────────────────────
    //
    // The adapter caches a write only while it is in flight so that a
    // fire-and-forget save is observable within the same process, then
    // drops the entry once the write settles. A failed write must still
    // drop cleanly: it must never leave a phantom entry in the cache map
    // or the prefix index that would surface bytes absent from disk.

    it("save() drops the failed key from cache and index on write failure", async () => {
      const key = ["AAAAAAAA", "snapshot", "hash"]
      await adapter.save(key, new Uint8Array([1, 1, 1]))

      // Force the next write to fail by dropping a regular file where
      // a fresh key's parent directory would need to be created, so its
      // mkdir fails.
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

      // The failed key must not be reported as having any value.
      expect(await adapter.load(blockerKey)).toBeUndefined()

      // A previously-saved key is still readable (from disk).
      const prior = await adapter.load(key)
      expect(prior).toBeDefined()
      expect(Array.from(prior!)).toEqual([1, 1, 1])

      // loadRange consults the prefix index (not the cache map directly),
      // so it would expose a phantom key if the failed write failed to
      // de-index. load() alone cannot catch that desync.
      const phantom = await adapter.loadRange(["BBBBBBBB"])
      expect(phantom.map(c => c.key)).not.toContainEqual(blockerKey)

      const intact = await adapter.loadRange(["AAAAAAAA"])
      expect(intact).toStrictEqual([{ key, data: new Uint8Array([1, 1, 1]) }])
    })

    // ─── saveBatch ────────────────────────────────────────────────────

    it("saveBatch persists every entry across multiple shards and leaves no tmp files", async () => {
      const entries: Array<[string[], Uint8Array]> = []
      for (let i = 0; i < 32; i++) {
        const hash = i.toString(16).padStart(8, "0")
        // Alternate shards so the batch spans multiple target dirs.
        const shard = i % 2 === 0 ? "AAAAAAAA" : "BBBBBBBB"
        entries.push([
          [shard, "incremental", hash],
          new Uint8Array([i, i, i, i]),
        ])
      }

      await adapter.saveBatch(entries)

      // Read via a fresh adapter so we hit on-disk bytes, not the
      // writer's in-memory cache.
      const fresh = new NodeFSStorageAdapter(dir)
      for (const [key, expected] of entries) {
        const loaded = await fresh.load(key)
        expect(loaded).toBeDefined()
        expect(Array.from(loaded!)).toEqual(Array.from(expected))
      }

      // The two-phase design must leave no staged tmp files behind on
      // successful commit.
      const tmpDir = path.join(dir, ".tmp")
      expect(fs.readdirSync(tmpDir)).toEqual([])
    })

    it("saveBatch([]) is a no-op", async () => {
      await adapter.saveBatch([])
      // Nothing to assert beyond "didn't throw" — but confirm directory
      // is still empty so we didn't accidentally create anything.
      const files = walkSync(dir)
      expect(files).toHaveLength(0)
    })

    it("saveBatch() aborts the whole batch when any entry's setup fails", async () => {
      // Staged semantics: if any entry can't be prepared (e.g. its
      // target directory can't be created), the whole batch is aborted
      // before any rename happens. No entry should end up observable on
      // disk, and every in-flight cache entry is released.
      const okKey1 = ["AAAAAAAA", "snapshot", "one"]
      const okKey2 = ["AAAAAAAA", "snapshot", "two"]
      const badKey = ["BBBBBBBB", "snapshot", "hash"]

      // Create a file-not-directory at an ancestor of the bad key so
      // its parent-dir mkdir fails.
      const adapterAny = adapter as unknown as {
        getFilePath(k: string[]): string
      }
      const badParent = path.dirname(adapterAny.getFilePath(badKey))
      fs.mkdirSync(path.dirname(badParent), { recursive: true })
      fs.writeFileSync(badParent, Buffer.from("block"))

      await expect(
        adapter.saveBatch([
          [okKey1, new Uint8Array([1])],
          [badKey, new Uint8Array([9])],
          [okKey2, new Uint8Array([2])],
        ])
      ).rejects.toBeDefined()

      // None of the entries should be observable: the batch was aborted
      // before any commit. Read via a fresh adapter to verify on-disk
      // state bypassing any in-memory cache.
      const fresh = new NodeFSStorageAdapter(dir)
      expect(await fresh.load(okKey1)).toBeUndefined()
      expect(await fresh.load(okKey2)).toBeUndefined()
      expect(await fresh.load(badKey)).toBeUndefined()

      // The writer's own reads must agree (its in-flight cache entries
      // were all released, so reads fall through to the empty disk).
      expect(await adapter.load(okKey1)).toBeUndefined()
      expect(await adapter.load(okKey2)).toBeUndefined()
      expect(await adapter.load(badKey)).toBeUndefined()

      // The prefix index must agree: no phantom keys survive the abort.
      // (The BBBBBBBB shard contains the blocker file we planted, so
      // assert on the absence of badKey rather than emptiness.)
      expect(await adapter.loadRange(["AAAAAAAA"])).toStrictEqual([])
      const bShard = await adapter.loadRange(["BBBBBBBB"])
      expect(bShard.map(c => c.key)).not.toContainEqual(badKey)
    })

    it("saveBatch() with a commit-phase failure keeps successful entries and drops the failed one", async () => {
      // Stage phase succeeds for every entry (tmp files are created in
      // <dir>/.tmp/). The commit phase's rename fails for badKey because
      // its target path already exists as a directory; the other entries
      // rename successfully. Expected outcome:
      //   - successful entries are durable on disk
      //   - the failed entry never becomes a readable value
      //   - load(badKey) throws EISDIR (a directory squatting on a key
      //     path is a corruption signal that must propagate)
      //   - no tmp files remain
      const okKey1 = ["AAAAAAAA", "snapshot", "one"]
      const okKey2 = ["CCCCCCCC", "snapshot", "two"]
      const badKey = ["BBBBBBBB", "snapshot", "hash"]

      // Make the bad key's target path a directory so rename fails
      // during the commit phase. Its parent dir exists, so stage-phase
      // mkdir of the parent succeeds.
      const adapterAny = adapter as unknown as {
        getFilePath(k: string[]): string
      }
      const badTarget = adapterAny.getFilePath(badKey)
      fs.mkdirSync(path.dirname(badTarget), { recursive: true })
      fs.mkdirSync(badTarget) // target-as-directory blocks rename

      await expect(
        adapter.saveBatch([
          [okKey1, new Uint8Array([1])],
          [badKey, new Uint8Array([9])],
          [okKey2, new Uint8Array([2])],
        ])
      ).rejects.toBeDefined()

      // Successful entries should be durable on disk (visible via a
      // fresh adapter bypassing the writer's cache).
      const fresh = new NodeFSStorageAdapter(dir)
      expect(Array.from((await fresh.load(okKey1))!)).toEqual([1])
      expect(Array.from((await fresh.load(okKey2))!)).toEqual([2])

      // The writer's own reads agree (its cache entries were released on
      // settle, so these read through to disk).
      expect(Array.from((await adapter.load(okKey1))!)).toEqual([1])
      expect(Array.from((await adapter.load(okKey2))!)).toEqual([2])

      // Failed entry: directory is still at the target path, so load()
      // surfaces EISDIR rather than silently returning undefined. This
      // is the corruption signal; load() MUST propagate it.
      await expect(adapter.load(badKey)).rejects.toMatchObject({
        code: "EISDIR",
      })
      await expect(fresh.load(badKey)).rejects.toMatchObject({
        code: "EISDIR",
      })

      // No staged tmp files should remain — successful renames moved
      // them to targets; the failing rename's tmp was unlinked.
      const tmpDir = path.join(dir, ".tmp")
      expect(fs.readdirSync(tmpDir)).toEqual([])

      // Prefix-index view: successful entries are listed with their new
      // bytes; the failed entry is de-indexed (its target is a directory,
      // which walkdir descends into and finds empty).
      expect(await adapter.loadRange(["AAAAAAAA"])).toStrictEqual([
        { key: okKey1, data: new Uint8Array([1]) },
      ])
      expect(await adapter.loadRange(["CCCCCCCC"])).toStrictEqual([
        { key: okKey2, data: new Uint8Array([2]) },
      ])
      expect(await adapter.loadRange(["BBBBBBBB"])).toStrictEqual([])
    })
  })

  // ─── Write cache lifetime ────────────────────────────────────────────
  //
  // The in-memory cache exists only for read-after-write consistency while
  // a write is in flight; it is dropped once the write settles so a
  // long-running process does not accumulate its whole storage directory in
  // memory. Overlapping writes to one key are refcounted. These tests gate
  // the commit (rename) step to hold a write in flight.

  describe("write cache lifetime", () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    const cacheSize = (adapter: NodeFSStorageAdapter) =>
      Object.keys((adapter as unknown as { cache: object }).cache).length

    it("does not retain chunk bytes after writes settle", async () => {
      const { adapter, teardown } = await setup()
      try {
        await adapter.save(["doc-a", "chunk1"], new Uint8Array([1]))
        await adapter.save(["doc-a", "chunk2"], new Uint8Array([2]))
        await adapter.save(["doc-b", "chunk1"], new Uint8Array([3]))

        assert.equal(cacheSize(adapter), 0)
        assert.deepEqual(
          await adapter.load(["doc-a", "chunk2"]),
          new Uint8Array([2])
        )
      } finally {
        teardown()
      }
    })

    it("serves an in-flight write to concurrent readers", async () => {
      const { adapter, teardown } = await setup()
      try {
        // Hold the commit (rename) open so the reads below race the
        // still-in-flight write. The cache entry lives until the write
        // settles, so the reads must see the written bytes from it.
        let releaseRename!: () => void
        const gate = new Promise<void>(resolve => {
          releaseRename = resolve
        })
        const originalRename = fs.promises.rename.bind(fs.promises)
        vi.spyOn(fs.promises, "rename").mockImplementation(async (...args) => {
          await gate
          return originalRename(...(args as [never, never]))
        })

        const pendingSave = adapter.save(
          ["doc-a", "chunk1"],
          new Uint8Array([7])
        )
        assert.deepEqual(
          await adapter.load(["doc-a", "chunk1"]),
          new Uint8Array([7]),
          "a read racing an in-flight write must see the written bytes"
        )
        const range = await adapter.loadRange(["doc-a"])
        assert.equal(range.length, 1)
        assert.deepEqual(range[0].data, new Uint8Array([7]))

        releaseRename()
        await pendingSave
        assert.equal(cacheSize(adapter), 0)
      } finally {
        teardown()
      }
    })

    it("keeps the latest bytes readable across overlapping saves to one key", async () => {
      const { adapter, teardown } = await setup()
      try {
        // Gate the commit (rename) of every overlapping write so both are
        // in flight at once. rename does not carry the payload, so collect
        // the releasers and fire them in call order.
        const releases: Array<() => void> = []
        const originalRename = fs.promises.rename.bind(fs.promises)
        vi.spyOn(fs.promises, "rename").mockImplementation(async (...args) => {
          await new Promise<void>(resolve => releases.push(resolve))
          return originalRename(...(args as [never, never]))
        })

        // Both saves run cacheSet synchronously before their first await,
        // so the single cache entry already holds the latest bytes ([2])
        // with a refcount of 2.
        const first = adapter.save(["doc-a", "chunk1"], new Uint8Array([1]))
        const second = adapter.save(["doc-a", "chunk1"], new Uint8Array([2]))

        // Wait until both writes have reached the gated rename.
        await vi.waitFor(() => assert.equal(releases.length, 2))

        releases[0]()
        await Promise.race([first, second])
        assert.deepEqual(
          await adapter.load(["doc-a", "chunk1"]),
          new Uint8Array([2]),
          "the entry must survive until the last overlapping write settles"
        )

        releases[1]()
        await Promise.all([first, second])
        assert.equal(cacheSize(adapter), 0)
      } finally {
        teardown()
      }
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
