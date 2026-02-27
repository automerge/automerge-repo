import { describe, it, expect, beforeEach, vi } from "vitest"
import { DummyStorageAdapter } from "./DummyStorageAdapter.js"
import { SubductionStorageBridge } from "../src/storage.js"
import { SedimentreeId, Digest } from "@automerge/automerge-subduction"

describe("SubductionStorageBridge", () => {
  let adapter: DummyStorageAdapter
  let bridge: SubductionStorageBridge

  beforeEach(() => {
    adapter = new DummyStorageAdapter()
    bridge = new SubductionStorageBridge(adapter)
  })

  const randomBytes = (length: number): Uint8Array =>
    Uint8Array.from({ length }, () => Math.floor(Math.random() * 256))

  describe("SedimentreeId operations", () => {
    it("saves and loads sedimentree IDs", async () => {
      const id1 = SedimentreeId.fromBytes(randomBytes(32))
      const id2 = SedimentreeId.fromBytes(randomBytes(32))

      await bridge.saveSedimentreeId(id1)
      await bridge.saveSedimentreeId(id2)

      const loaded = await bridge.loadAllSedimentreeIds()
      expect(loaded.length).toBe(2)

      const loadedStrings = loaded.map(id => id.toString())
      expect(loadedStrings).toContain(id1.toString())
      expect(loadedStrings).toContain(id2.toString())
    })

    it("deletes sedimentree IDs", async () => {
      const id1 = SedimentreeId.fromBytes(randomBytes(32))
      const id2 = SedimentreeId.fromBytes(randomBytes(32))

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

  describe("Commit operations (CAS)", () => {
    it("saves and loads commits by digest", async () => {
      const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
      const signedCommit = randomBytes(200) // Opaque CBOR bytes
      const digest = Digest.hash(signedCommit)
      // For commits, blobDigest is the same as digest
      const blobDigest = digest

      await bridge.saveCommit(sedimentreeId, digest, signedCommit, blobDigest)

      const loaded = await bridge.loadCommit(sedimentreeId, digest)
      expect(loaded).not.toBeNull()
      expect(loaded).toEqual(signedCommit)
    })

    it("returns null for non-existent commit", async () => {
      const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
      const digest = Digest.hash(randomBytes(64))

      const loaded = await bridge.loadCommit(sedimentreeId, digest)
      expect(loaded).toBeNull()
    })

    it("lists commit digests", async () => {
      const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
      const commit1 = randomBytes(100)
      const commit2 = randomBytes(150)
      const digest1 = Digest.hash(commit1)
      const digest2 = Digest.hash(commit2)

      await bridge.saveCommit(sedimentreeId, digest1, commit1, digest1)
      await bridge.saveCommit(sedimentreeId, digest2, commit2, digest2)

      const digests = await bridge.listCommitDigests(sedimentreeId)
      expect(digests.length).toBe(2)

      const digestStrings = digests.map(d => d.toHexString())
      expect(digestStrings).toContain(digest1.toHexString())
      expect(digestStrings).toContain(digest2.toHexString())
    })

    it("loads all commits with digests", async () => {
      const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
      const commit1 = randomBytes(100)
      const commit2 = randomBytes(150)
      const digest1 = Digest.hash(commit1)
      const digest2 = Digest.hash(commit2)

      await bridge.saveCommit(sedimentreeId, digest1, commit1, digest1)
      await bridge.saveCommit(sedimentreeId, digest2, commit2, digest2)

      const loaded = await bridge.loadAllCommits(sedimentreeId)
      expect(loaded.length).toBe(2)

      const found1 = loaded.find(
        c => c.digest.toHexString() === digest1.toHexString()
      )
      const found2 = loaded.find(
        c => c.digest.toHexString() === digest2.toHexString()
      )

      expect(found1).toBeDefined()
      expect(found1!.signed).toEqual(commit1)
      expect(found2).toBeDefined()
      expect(found2!.signed).toEqual(commit2)
    })

    it("deletes single commit by digest", async () => {
      const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
      const commit1 = randomBytes(100)
      const commit2 = randomBytes(150)
      const digest1 = Digest.hash(commit1)
      const digest2 = Digest.hash(commit2)

      await bridge.saveCommit(sedimentreeId, digest1, commit1, digest1)
      await bridge.saveCommit(sedimentreeId, digest2, commit2, digest2)

      await bridge.deleteCommit(sedimentreeId, digest1)

      const loaded1 = await bridge.loadCommit(sedimentreeId, digest1)
      const loaded2 = await bridge.loadCommit(sedimentreeId, digest2)

      expect(loaded1).toBeNull()
      expect(loaded2).toEqual(commit2)
    })

    it("deletes all commits for a sedimentree", async () => {
      const id1 = SedimentreeId.fromBytes(randomBytes(32))
      const id2 = SedimentreeId.fromBytes(randomBytes(32))
      const commit1 = randomBytes(100)
      const commit2 = randomBytes(150)
      const digest1 = Digest.hash(commit1)
      const digest2 = Digest.hash(commit2)

      await bridge.saveCommit(id1, digest1, commit1, digest1)
      await bridge.saveCommit(id2, digest2, commit2, digest2)

      await bridge.deleteAllCommits(id1)

      const loaded1 = await bridge.loadAllCommits(id1)
      const loaded2 = await bridge.loadAllCommits(id2)

      expect(loaded1.length).toBe(0)
      expect(loaded2.length).toBe(1)
    })

    it("isolates commits between different sedimentrees", async () => {
      const id1 = SedimentreeId.fromBytes(randomBytes(32))
      const id2 = SedimentreeId.fromBytes(randomBytes(32))
      const commit1 = randomBytes(100)
      const commit2 = randomBytes(150)
      const digest1 = Digest.hash(commit1)
      const digest2 = Digest.hash(commit2)

      await bridge.saveCommit(id1, digest1, commit1, digest1)
      await bridge.saveCommit(id2, digest2, commit2, digest2)

      const loaded1 = await bridge.loadAllCommits(id1)
      const loaded2 = await bridge.loadAllCommits(id2)

      expect(loaded1.length).toBe(1)
      expect(loaded2.length).toBe(1)
      expect(loaded1[0].signed).toEqual(commit1)
      expect(loaded2[0].signed).toEqual(commit2)
    })
  })

  describe("Fragment operations (CAS)", () => {
    it("saves and loads fragments by digest", async () => {
      const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
      const signedFragment = randomBytes(300) // Opaque CBOR bytes
      const digest = Digest.hash(signedFragment)
      // For fragments, blobDigest is separate (the bundle's digest)
      const blobDigest = Digest.hash(randomBytes(500))

      await bridge.saveFragment(
        sedimentreeId,
        digest,
        signedFragment,
        blobDigest
      )

      const loaded = await bridge.loadFragment(sedimentreeId, digest)
      expect(loaded).not.toBeNull()
      expect(loaded).toEqual(signedFragment)
    })

    it("returns null for non-existent fragment", async () => {
      const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
      const digest = Digest.hash(randomBytes(64))

      const loaded = await bridge.loadFragment(sedimentreeId, digest)
      expect(loaded).toBeNull()
    })

    it("lists fragment digests", async () => {
      const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
      const fragment1 = randomBytes(200)
      const fragment2 = randomBytes(250)
      const digest1 = Digest.hash(fragment1)
      const digest2 = Digest.hash(fragment2)
      const blobDigest1 = Digest.hash(randomBytes(500))
      const blobDigest2 = Digest.hash(randomBytes(600))

      await bridge.saveFragment(sedimentreeId, digest1, fragment1, blobDigest1)
      await bridge.saveFragment(sedimentreeId, digest2, fragment2, blobDigest2)

      const digests = await bridge.listFragmentDigests(sedimentreeId)
      expect(digests.length).toBe(2)

      const digestStrings = digests.map(d => d.toHexString())
      expect(digestStrings).toContain(digest1.toHexString())
      expect(digestStrings).toContain(digest2.toHexString())
    })

    it("loads all fragments with digests", async () => {
      const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
      const fragment1 = randomBytes(200)
      const fragment2 = randomBytes(250)
      const digest1 = Digest.hash(fragment1)
      const digest2 = Digest.hash(fragment2)
      const blobDigest1 = Digest.hash(randomBytes(500))
      const blobDigest2 = Digest.hash(randomBytes(600))

      await bridge.saveFragment(sedimentreeId, digest1, fragment1, blobDigest1)
      await bridge.saveFragment(sedimentreeId, digest2, fragment2, blobDigest2)

      const loaded = await bridge.loadAllFragments(sedimentreeId)
      expect(loaded.length).toBe(2)

      const found1 = loaded.find(
        f => f.digest.toHexString() === digest1.toHexString()
      )
      const found2 = loaded.find(
        f => f.digest.toHexString() === digest2.toHexString()
      )

      expect(found1).toBeDefined()
      expect(found1!.signed).toEqual(fragment1)
      expect(found2).toBeDefined()
      expect(found2!.signed).toEqual(fragment2)
    })

    it("deletes single fragment by digest", async () => {
      const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
      const fragment1 = randomBytes(200)
      const fragment2 = randomBytes(250)
      const digest1 = Digest.hash(fragment1)
      const digest2 = Digest.hash(fragment2)
      const blobDigest1 = Digest.hash(randomBytes(500))
      const blobDigest2 = Digest.hash(randomBytes(600))

      await bridge.saveFragment(sedimentreeId, digest1, fragment1, blobDigest1)
      await bridge.saveFragment(sedimentreeId, digest2, fragment2, blobDigest2)

      await bridge.deleteFragment(sedimentreeId, digest1)

      const loaded1 = await bridge.loadFragment(sedimentreeId, digest1)
      const loaded2 = await bridge.loadFragment(sedimentreeId, digest2)

      expect(loaded1).toBeNull()
      expect(loaded2).toEqual(fragment2)
    })

    it("deletes all fragments for a sedimentree", async () => {
      const id1 = SedimentreeId.fromBytes(randomBytes(32))
      const id2 = SedimentreeId.fromBytes(randomBytes(32))
      const fragment1 = randomBytes(200)
      const fragment2 = randomBytes(250)
      const digest1 = Digest.hash(fragment1)
      const digest2 = Digest.hash(fragment2)
      const blobDigest1 = Digest.hash(randomBytes(500))
      const blobDigest2 = Digest.hash(randomBytes(600))

      await bridge.saveFragment(id1, digest1, fragment1, blobDigest1)
      await bridge.saveFragment(id2, digest2, fragment2, blobDigest2)

      await bridge.deleteAllFragments(id1)

      const loaded1 = await bridge.loadAllFragments(id1)
      const loaded2 = await bridge.loadAllFragments(id2)

      expect(loaded1.length).toBe(0)
      expect(loaded2.length).toBe(1)
    })

    it("isolates fragments between different sedimentrees", async () => {
      const id1 = SedimentreeId.fromBytes(randomBytes(32))
      const id2 = SedimentreeId.fromBytes(randomBytes(32))
      const fragment1 = randomBytes(200)
      const fragment2 = randomBytes(250)
      const digest1 = Digest.hash(fragment1)
      const digest2 = Digest.hash(fragment2)
      const blobDigest1 = Digest.hash(randomBytes(500))
      const blobDigest2 = Digest.hash(randomBytes(600))

      await bridge.saveFragment(id1, digest1, fragment1, blobDigest1)
      await bridge.saveFragment(id2, digest2, fragment2, blobDigest2)

      const loaded1 = await bridge.loadAllFragments(id1)
      const loaded2 = await bridge.loadAllFragments(id2)

      expect(loaded1.length).toBe(1)
      expect(loaded2.length).toBe(1)
      expect(loaded1[0].signed).toEqual(fragment1)
      expect(loaded2[0].signed).toEqual(fragment2)
    })
  })

  describe("Blob operations", () => {
    it("saves and loads blobs", async () => {
      const data = randomBytes(256)
      const digest = await bridge.saveBlob(data)

      const loaded = await bridge.loadBlob(digest)
      expect(loaded).not.toBeNull()
      expect(loaded).toEqual(data)
    })

    it("returns null for non-existent blob", async () => {
      const digest = Digest.hash(randomBytes(64))
      const loaded = await bridge.loadBlob(digest)
      expect(loaded).toBeNull()
    })

    it("deletes blobs", async () => {
      const data = randomBytes(128)
      const digest = await bridge.saveBlob(data)

      await bridge.deleteBlob(digest)

      const loaded = await bridge.loadBlob(digest)
      expect(loaded).toBeNull()
    })

    it("handles large blobs", async () => {
      const data = randomBytes(1024 * 1024)
      const digest = await bridge.saveBlob(data)

      const loaded = await bridge.loadBlob(digest)
      expect(loaded).toEqual(data)
    })

    it("returns correct digest for blob content", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const expectedDigest = Digest.hash(data)

      const returnedDigest = await bridge.saveBlob(data)
      expect(returnedDigest.toHexString()).toBe(expectedDigest.toHexString())
    })
  })

  describe("Event system", () => {
    it("emits blob-saved event", async () => {
      const callback = vi.fn()
      bridge.on("blob-saved", callback)

      const data = randomBytes(64)
      await bridge.saveBlob(data)

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(expect.any(Digest), data)
    })

    it("emits commit-saved event", async () => {
      const callback = vi.fn()
      bridge.on("commit-saved", callback)

      const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
      const signedCommit = randomBytes(200)
      const digest = Digest.hash(signedCommit)
      // Save the blob first (for commits, blobDigest = digest)
      const blobData = randomBytes(150)
      const blobDigest = await bridge.saveBlob(blobData)

      await bridge.saveCommit(sedimentreeId, digest, signedCommit, blobDigest)

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(sedimentreeId, digest, blobData)
    })

    it("emits fragment-saved event", async () => {
      const callback = vi.fn()
      bridge.on("fragment-saved", callback)

      const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
      const signedFragment = randomBytes(300)
      const digest = Digest.hash(signedFragment)
      // Save the blob first (for fragments, blobDigest is the bundle digest)
      const blobData = randomBytes(500)
      const blobDigest = await bridge.saveBlob(blobData)

      await bridge.saveFragment(
        sedimentreeId,
        digest,
        signedFragment,
        blobDigest
      )

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(sedimentreeId, digest, blobData)
    })

    it("removes event listeners with off()", async () => {
      const callback = vi.fn()
      bridge.on("blob-saved", callback)
      bridge.off("blob-saved", callback)

      await bridge.saveBlob(randomBytes(64))

      expect(callback).not.toHaveBeenCalled()
    })

    it("supports multiple listeners for same event", async () => {
      const callback1 = vi.fn()
      const callback2 = vi.fn()

      bridge.on("blob-saved", callback1)
      bridge.on("blob-saved", callback2)

      await bridge.saveBlob(randomBytes(64))

      expect(callback1).toHaveBeenCalledTimes(1)
      expect(callback2).toHaveBeenCalledTimes(1)
    })
  })
})
