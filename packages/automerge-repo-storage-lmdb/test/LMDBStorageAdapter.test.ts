import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { open } from "lmdb"
import { describe, expect, it } from "vitest"

import { runStorageAdapterTests } from "../../automerge-repo/src/helpers/tests/storage-adapter-tests.js"
import type { StorageKey } from "@automerge/automerge-repo/slim"
import { LMDBStorageAdapter } from "../src/index.js"

const tempDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "automerge-lmdb-test-"))

describe("LMDBStorageAdapter", () => {
  const setup = async () => {
    const dir = tempDir()
    const adapter = new LMDBStorageAdapter(dir)
    return {
      adapter,
      teardown: async () => {
        await adapter.close()
        fs.rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  runStorageAdapterTests(setup, "LMDBStorageAdapter")

  it("does not treat a sibling with a shared string prefix as a descendant", async () => {
    const { adapter, teardown } = await setup()
    try {
      await adapter.save(["AA", "x"], new Uint8Array([1]))
      await adapter.save(["AAB", "x"], new Uint8Array([2]))

      const chunks = await adapter.loadRange(["AA"])
      expect(chunks.map(c => c.key)).toStrictEqual([["AA", "x"]])
    } finally {
      await teardown()
    }
  })

  it("handles hostile key segments (unicode, empty, control chars)", async () => {
    const { adapter, teardown } = await setup()
    try {
      const keys: StorageKey[] = [
        ["doc", "\u{1f409}\u{1f30b}", "snapshot"],
        ["doc", "", "empty-segment"],
        ["doc", "a\x1fb\x00c", "control-chars"],
        ["doc", "%2F%25", "percent-escapes"],
      ]
      for (const [i, key] of keys.entries()) {
        await adapter.save(key, new Uint8Array([i]))
      }
      for (const [i, key] of keys.entries()) {
        expect(await adapter.load(key), key.join("|")).toStrictEqual(
          new Uint8Array([i])
        )
      }
      expect((await adapter.loadRange(["doc"])).length).toBe(keys.length)
    } finally {
      await teardown()
    }
  })

  it("saveBatch is atomic: a failing entry makes nothing observable", async () => {
    const { adapter, teardown } = await setup()
    try {
      // LMDB rejects keys longer than its limit (~1978 bytes); the oversized
      // final entry must abort the earlier entries too.
      const oversized = "x".repeat(4096)
      await expect(
        adapter.saveBatch([
          [["batch", "a"], new Uint8Array([1])],
          [["batch", "b"], new Uint8Array([2])],
          [["batch", oversized], new Uint8Array([3])],
        ])
      ).rejects.toThrow()

      expect(await adapter.load(["batch", "a"])).toBeUndefined()
      expect(await adapter.load(["batch", "b"])).toBeUndefined()
      expect(await adapter.loadRange(["batch"])).toStrictEqual([])
    } finally {
      await teardown()
    }
  })

  it("persists across close and reopen", async () => {
    const dir = tempDir()
    try {
      const first = new LMDBStorageAdapter(dir)
      await first.save(["doc", "snapshot", "abc"], new Uint8Array([7, 8, 9]))
      await first.close()

      const second = new LMDBStorageAdapter(dir)
      expect(await second.load(["doc", "snapshot", "abc"])).toStrictEqual(
        new Uint8Array([7, 8, 9])
      )
      await second.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not close a caller-supplied database", async () => {
    const dir = tempDir()
    try {
      const db = open<Uint8Array, StorageKey>({ path: dir, encoding: "binary" })
      const adapter = new LMDBStorageAdapter(db)

      await adapter.save(["k"], new Uint8Array([1]))
      await adapter.close()

      // The database must still be usable: the adapter didn't own it.
      expect(new Uint8Array(db.get(["k"])!)).toStrictEqual(new Uint8Array([1]))
      await db.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("save is durable even when the caller reuses its buffer", async () => {
    const { adapter, teardown } = await setup()
    try {
      const buffer = new Uint8Array([1, 2, 3])
      const pending = adapter.save(["reuse"], buffer)
      buffer.fill(0) // caller clobbers the buffer before the commit lands
      await pending

      expect(await adapter.load(["reuse"])).toStrictEqual(
        new Uint8Array([1, 2, 3])
      )
    } finally {
      await teardown()
    }
  })
})
