import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { assert, afterEach, describe, it, vi } from "vitest"
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
        // Hold the file write open so the read below races it.
        let releaseWrite!: () => void
        const gate = new Promise<void>(resolve => {
          releaseWrite = resolve
        })
        const originalWriteFile = fs.promises.writeFile.bind(fs.promises)
        vi.spyOn(fs.promises, "writeFile").mockImplementation(
          async (...args) => {
            await gate
            return originalWriteFile(...(args as [never, never]))
          }
        )

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

        releaseWrite()
        await pendingSave
        assert.equal(cacheSize(adapter), 0)
      } finally {
        teardown()
      }
    })

    it("keeps the latest bytes readable across overlapping saves to one key", async () => {
      const { adapter, teardown } = await setup()
      try {
        // Gate each write by its payload byte: concurrent mkdir scheduling
        // does not guarantee the writes reach writeFile in save order.
        const gates = new Map<number, () => void>()
        const originalWriteFile = fs.promises.writeFile.bind(fs.promises)
        vi.spyOn(fs.promises, "writeFile").mockImplementation(
          async (...args) => {
            const byte = (args[1] as Uint8Array)[0]
            await new Promise<void>(resolve => gates.set(byte, resolve))
            return originalWriteFile(...(args as [never, never]))
          }
        )

        const first = adapter.save(["doc-a", "chunk1"], new Uint8Array([1]))
        const second = adapter.save(["doc-a", "chunk1"], new Uint8Array([2]))

        // Both writes pass mkdir before reaching the gated writeFile.
        await vi.waitFor(() => assert.equal(gates.size, 2))
        gates.get(1)!()
        await first
        assert.deepEqual(
          await adapter.load(["doc-a", "chunk1"]),
          new Uint8Array([2]),
          "the entry must survive until the last overlapping write settles"
        )

        gates.get(2)!()
        await second
        assert.equal(cacheSize(adapter), 0)
      } finally {
        teardown()
      }
    })
  })
})
