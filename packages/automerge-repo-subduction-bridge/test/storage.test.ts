import { describe, it, expect, beforeEach, vi } from "vitest"
import { DummyStorageAdapter } from "../../automerge-repo/src/helpers/DummyStorageAdapter.js"
import { SubductionStorageBridge } from "../src/storage.js"
import {
    SedimentreeId,
    LooseCommit,
    Fragment,
    Digest,
    BlobMeta,
} from "@automerge/automerge_subduction"

describe("SubductionStorageBridge", () => {
    let adapter: DummyStorageAdapter
    let bridge: SubductionStorageBridge

    beforeEach(() => {
        adapter = new DummyStorageAdapter()
        bridge = new SubductionStorageBridge(adapter)
    })

    const randomBytes = (length: number): Uint8Array =>
        Uint8Array.from({ length }, () => Math.floor(Math.random() * 256))

    const createLooseCommit = ({
        data,
        numParents,
    }: {
        data: Uint8Array
        numParents: number
    }): LooseCommit =>
        new LooseCommit(
            Digest.hash(data),
            Array.from({ length: numParents }, () =>
                Digest.hash(randomBytes(64))
            ),
            new BlobMeta(data)
        )

    const createFragment = ({
        data,
        numBoundary,
        numCheckpoints,
    }: {
        data: Uint8Array
        numBoundary: number
        numCheckpoints: number
    }): Fragment =>
        new Fragment(
            Digest.hash(data),
            Array.from({ length: numBoundary }, () =>
                Digest.hash(randomBytes(64))
            ),
            Array.from({ length: numCheckpoints }, () =>
                Digest.hash(randomBytes(64))
            ),
            new BlobMeta(data)
        )

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

    describe("LooseCommit operations", () => {
        it("saves and loads loose commits", async () => {
            const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
            const data = randomBytes(100)
            const commit = createLooseCommit({ data, numParents: 2 })

            await bridge.saveLooseCommit(sedimentreeId, commit)

            const loaded = await bridge.loadLooseCommits(sedimentreeId)
            expect(loaded.length).toBe(1)

            const loadedCommit = loaded[0]
            expect(loadedCommit.digest.toHexString()).toBe(
                commit.digest.toHexString()
            )
            expect(loadedCommit.parents.length).toBe(2)
            expect(loadedCommit.blobMeta.sizeBytes).toBe(
                commit.blobMeta.sizeBytes
            )
        })

        it("saves multiple commits for same sedimentree", async () => {
            const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
            const commit1 = createLooseCommit({
                data: randomBytes(50),
                numParents: 1,
            })
            const commit2 = createLooseCommit({
                data: randomBytes(60),
                numParents: 0,
            })
            const commit3 = createLooseCommit({
                data: randomBytes(70),
                numParents: 3,
            })

            await bridge.saveLooseCommit(sedimentreeId, commit1)
            await bridge.saveLooseCommit(sedimentreeId, commit2)
            await bridge.saveLooseCommit(sedimentreeId, commit3)

            const loaded = await bridge.loadLooseCommits(sedimentreeId)
            expect(loaded.length).toBe(3)
        })

        it("isolates commits between different sedimentrees", async () => {
            const id1 = SedimentreeId.fromBytes(randomBytes(32))
            const id2 = SedimentreeId.fromBytes(randomBytes(32))
            const commit1 = createLooseCommit({
                data: randomBytes(50),
                numParents: 0,
            })
            const commit2 = createLooseCommit({
                data: randomBytes(60),
                numParents: 0,
            })

            await bridge.saveLooseCommit(id1, commit1)
            await bridge.saveLooseCommit(id2, commit2)

            const loaded1 = await bridge.loadLooseCommits(id1)
            const loaded2 = await bridge.loadLooseCommits(id2)

            expect(loaded1.length).toBe(1)
            expect(loaded2.length).toBe(1)
            expect(loaded1[0].digest.toHexString()).toBe(
                commit1.digest.toHexString()
            )
            expect(loaded2[0].digest.toHexString()).toBe(
                commit2.digest.toHexString()
            )
        })

        it("deletes loose commits for a sedimentree", async () => {
            const id1 = SedimentreeId.fromBytes(randomBytes(32))
            const id2 = SedimentreeId.fromBytes(randomBytes(32))
            const commit1 = createLooseCommit({
                data: randomBytes(50),
                numParents: 0,
            })
            const commit2 = createLooseCommit({
                data: randomBytes(60),
                numParents: 0,
            })

            await bridge.saveLooseCommit(id1, commit1)
            await bridge.saveLooseCommit(id2, commit2)
            await bridge.deleteLooseCommits(id1)

            const loaded1 = await bridge.loadLooseCommits(id1)
            const loaded2 = await bridge.loadLooseCommits(id2)

            expect(loaded1.length).toBe(0)
            expect(loaded2.length).toBe(1)
        })
    })

    describe("Fragment operations", () => {
        it("saves and loads fragments", async () => {
            const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
            const data = randomBytes(100)
            const fragment = createFragment({
                data,
                numBoundary: 2,
                numCheckpoints: 3,
            })

            await bridge.saveFragment(sedimentreeId, fragment)

            const loaded = await bridge.loadFragments(sedimentreeId)
            expect(loaded.length).toBe(1)

            const loadedFragment = loaded[0]
            expect(loadedFragment.head.toHexString()).toBe(
                fragment.head.toHexString()
            )
            expect(loadedFragment.boundary.length).toBe(2)
            expect(loadedFragment.checkpoints.length).toBe(3)
            expect(loadedFragment.blobMeta.sizeBytes).toBe(
                fragment.blobMeta.sizeBytes
            )
        })

        it("saves multiple fragments for same sedimentree", async () => {
            const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
            const fragment1 = createFragment({
                data: randomBytes(50),
                numBoundary: 1,
                numCheckpoints: 1,
            })
            const fragment2 = createFragment({
                data: randomBytes(60),
                numBoundary: 2,
                numCheckpoints: 2,
            })

            await bridge.saveFragment(sedimentreeId, fragment1)
            await bridge.saveFragment(sedimentreeId, fragment2)

            const loaded = await bridge.loadFragments(sedimentreeId)
            expect(loaded.length).toBe(2)
        })

        it("deletes fragments for a sedimentree", async () => {
            const id1 = SedimentreeId.fromBytes(randomBytes(32))
            const id2 = SedimentreeId.fromBytes(randomBytes(32))
            const fragment1 = createFragment({
                data: randomBytes(50),
                numBoundary: 0,
                numCheckpoints: 0,
            })
            const fragment2 = createFragment({
                data: randomBytes(60),
                numBoundary: 0,
                numCheckpoints: 0,
            })

            await bridge.saveFragment(id1, fragment1)
            await bridge.saveFragment(id2, fragment2)
            await bridge.deleteFragments(id1)

            const loaded1 = await bridge.loadFragments(id1)
            const loaded2 = await bridge.loadFragments(id2)

            expect(loaded1.length).toBe(0)
            expect(loaded2.length).toBe(1)
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
            expect(returnedDigest.toHexString()).toBe(
                expectedDigest.toHexString()
            )
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

        it("emits commit-saved event when blob exists", async () => {
            const callback = vi.fn()
            bridge.on("commit-saved", callback)

            const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
            const data = randomBytes(64)

            await bridge.saveBlob(data)

            const commit = createLooseCommit({ data, numParents: 0 })
            await bridge.saveLooseCommit(sedimentreeId, commit)

            expect(callback).toHaveBeenCalledTimes(1)
        })

        it("emits fragment-saved event when blob exists", async () => {
            const callback = vi.fn()
            bridge.on("fragment-saved", callback)

            const sedimentreeId = SedimentreeId.fromBytes(randomBytes(32))
            const data = randomBytes(64)

            await bridge.saveBlob(data)

            const fragment = createFragment({
                data,
                numBoundary: 0,
                numCheckpoints: 0,
            })
            await bridge.saveFragment(sedimentreeId, fragment)

            expect(callback).toHaveBeenCalledTimes(1)
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
