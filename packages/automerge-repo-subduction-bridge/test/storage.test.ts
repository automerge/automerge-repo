import { describe, it, expect, beforeEach, vi } from "vitest"
import { DummyStorageAdapter } from "./DummyStorageAdapter.js"
import { SubductionStorageBridge } from "../src/storage.js"
import { initSubductionModule } from "../src/index.js"
// Tests run in Node/Vitest (not a bundler), so the bare specifier is safe
// — it resolves to the `node` entrypoint which auto-inits Wasm from disk.
import * as subductionModule from "@automerge/automerge-subduction"
import {
  BlobMeta,
  Digest,
  Fragment,
  LooseCommit,
  MemorySigner,
  SedimentreeId,
  Subduction,
} from "@automerge/automerge-subduction"

initSubductionModule(subductionModule)

const randomBytes = (length: number): Uint8Array =>
  Uint8Array.from({ length }, () => Math.floor(Math.random() * 256))

/** Create a random Digest (32 bytes). */
const randomDigest = (): Digest => Digest.fromBytes(randomBytes(32))

/** Create a random SedimentreeId. */
const randomSedimentreeId = (): SedimentreeId =>
  SedimentreeId.fromBytes(randomBytes(32))

/**
 * Produce a signed commit and its blob by round-tripping through
 * a throwaway Subduction instance.
 *
 * `addCommit` internally signs via `MemorySigner`, persists the
 * `SignedLooseCommit` + blob through the storage interface, and
 * we capture the result from the bridge's underlying adapter.
 */
async function makeSignedCommit(bridge: SubductionStorageBridge) {
  const signer = MemorySigner.generate()
  const sub = await Subduction.hydrate(signer, bridge)

  const sedimentreeId = randomSedimentreeId()
  const blob = randomBytes(128)

  await sub.addCommit(sedimentreeId, [], blob)

  // The commit was persisted through the bridge — pull it back out
  const commits = await bridge.loadAllCommits(sedimentreeId)
  expect(commits.length).toBeGreaterThanOrEqual(1)

  const commit = commits[0]
  return { sedimentreeId, commit, sub }
}

describe("SubductionStorageBridge", () => {
  let adapter: DummyStorageAdapter
  let bridge: SubductionStorageBridge

  beforeEach(() => {
    adapter = new DummyStorageAdapter()
    bridge = new SubductionStorageBridge(adapter)
  })

  describe("SedimentreeId operations", () => {
    it("saves and loads sedimentree IDs", async () => {
      const id1 = randomSedimentreeId()
      const id2 = randomSedimentreeId()

      await bridge.saveSedimentreeId(id1)
      await bridge.saveSedimentreeId(id2)

      const loaded = await bridge.loadAllSedimentreeIds()
      expect(loaded.length).toBe(2)

      const loadedStrings = loaded.map(id => id.toString())
      expect(loadedStrings).toContain(id1.toString())
      expect(loadedStrings).toContain(id2.toString())
    })

    it("deletes sedimentree IDs", async () => {
      const id1 = randomSedimentreeId()
      const id2 = randomSedimentreeId()

      await bridge.saveSedimentreeId(id1)
      await bridge.saveSedimentreeId(id2)
      await bridge.deleteSedimentreeId(id1)

      const loaded = await bridge.loadAllSedimentreeIds()
      expect(loaded.length).toBe(1)
      expect(loaded[0].toString()).toBe(id2.toString())
    })

    it("handles empty sedimentree ID list", async () => {
      const loaded = await bridge.loadAllSedimentreeIds()
      expect(loaded).toEqual([])
    })
  })

  describe("Commit operations via Subduction round-trip", () => {
    it("stores and loads commits produced by Subduction", async () => {
      const { sedimentreeId, commit } = await makeSignedCommit(bridge)

      // Verify the loaded commit has a signed payload and blob
      expect(commit.signed).toBeDefined()
      expect(commit.blob).toBeDefined()
      expect(commit.blob.length).toBeGreaterThan(0)

      // Verify we can re-load by digest
      const digest = commit.signed.payload.digest
      const reloaded = await bridge.loadCommit(sedimentreeId, digest)
      expect(reloaded).not.toBeNull()
    })

    it("returns null for non-existent commit", async () => {
      const sedimentreeId = randomSedimentreeId()
      const digest = randomDigest()

      const loaded = await bridge.loadCommit(sedimentreeId, digest)
      expect(loaded).toBeNull()
    })

    it("lists commit digests", async () => {
      const signer = MemorySigner.generate()
      const sedimentreeId = randomSedimentreeId()
      const sub = await Subduction.hydrate(signer, bridge)

      // Add two commits (second depends on first)
      await sub.addCommit(sedimentreeId, [], randomBytes(64))

      const commits = await bridge.loadAllCommits(sedimentreeId)
      const firstDigest = commits[0].signed.payload.digest

      await sub.addCommit(sedimentreeId, [firstDigest], randomBytes(64))

      const digests = await bridge.listCommitDigests(sedimentreeId)
      expect(digests.length).toBe(2)
    })

    it("deletes single commit by digest", async () => {
      const signer = MemorySigner.generate()
      const sedimentreeId = randomSedimentreeId()
      const sub = await Subduction.hydrate(signer, bridge)

      await sub.addCommit(sedimentreeId, [], randomBytes(64))

      const commits = await bridge.loadAllCommits(sedimentreeId)
      expect(commits.length).toBe(1)
      const digest = commits[0].signed.payload.digest

      await bridge.deleteCommit(sedimentreeId, digest)

      const reloaded = await bridge.loadCommit(sedimentreeId, digest)
      expect(reloaded).toBeNull()
    })

    it("deletes all commits for a sedimentree", async () => {
      const signer = MemorySigner.generate()
      const id1 = randomSedimentreeId()
      const id2 = randomSedimentreeId()
      const sub = await Subduction.hydrate(signer, bridge)

      await sub.addCommit(id1, [], randomBytes(64))
      await sub.addCommit(id2, [], randomBytes(64))

      await bridge.deleteAllCommits(id1)

      const loaded1 = await bridge.loadAllCommits(id1)
      const loaded2 = await bridge.loadAllCommits(id2)

      expect(loaded1.length).toBe(0)
      expect(loaded2.length).toBe(1)
    })

    it("isolates commits between different sedimentrees", async () => {
      const signer = MemorySigner.generate()
      const id1 = randomSedimentreeId()
      const id2 = randomSedimentreeId()
      const sub = await Subduction.hydrate(signer, bridge)

      await sub.addCommit(id1, [], randomBytes(64))
      await sub.addCommit(id2, [], randomBytes(128))

      const loaded1 = await bridge.loadAllCommits(id1)
      const loaded2 = await bridge.loadAllCommits(id2)

      expect(loaded1.length).toBe(1)
      expect(loaded2.length).toBe(1)
    })
  })

  describe("Fragment operations", () => {
    it("returns null for non-existent fragment", async () => {
      const sedimentreeId = randomSedimentreeId()
      const digest = randomDigest()

      const loaded = await bridge.loadFragment(sedimentreeId, digest)
      expect(loaded).toBeNull()
    })

    it("returns empty list for sedimentree with no fragments", async () => {
      const sedimentreeId = randomSedimentreeId()

      const digests = await bridge.listFragmentDigests(sedimentreeId)
      expect(digests.length).toBe(0)

      const fragments = await bridge.loadAllFragments(sedimentreeId)
      expect(fragments.length).toBe(0)
    })

    it("deleteAllFragments on empty sedimentree is a no-op", async () => {
      const sedimentreeId = randomSedimentreeId()
      await bridge.deleteAllFragments(sedimentreeId)

      const loaded = await bridge.loadAllFragments(sedimentreeId)
      expect(loaded.length).toBe(0)
    })
  })

  describe("Event system", () => {
    it("emits commit-saved event when Subduction persists a commit", async () => {
      const callback = vi.fn()
      bridge.on("commit-saved", callback)

      await makeSignedCommit(bridge)

      expect(callback).toHaveBeenCalledTimes(1)
      // commit-saved is called with (sedimentreeId, digest, blobData)
      const [sid, digest, blob] = callback.mock.calls[0]
      expect(sid).toBeDefined()
      expect(digest).toBeDefined()
      expect(blob).toBeInstanceOf(Uint8Array)
      expect(blob.length).toBeGreaterThan(0)
    })

    it("removes event listeners with off()", async () => {
      const callback = vi.fn()
      bridge.on("commit-saved", callback)
      bridge.off("commit-saved", callback)

      await makeSignedCommit(bridge)

      expect(callback).not.toHaveBeenCalled()
    })

    it("supports multiple listeners for same event", async () => {
      const callback1 = vi.fn()
      const callback2 = vi.fn()

      bridge.on("commit-saved", callback1)
      bridge.on("commit-saved", callback2)

      await makeSignedCommit(bridge)

      expect(callback1).toHaveBeenCalledTimes(1)
      expect(callback2).toHaveBeenCalledTimes(1)
    })
  })
})
