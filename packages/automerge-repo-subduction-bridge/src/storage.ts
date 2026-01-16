/**
 * Bridge that allows Subduction to use automerge-repo storage adapters.
 *
 * @example
 * ```ts
 * import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
 * import { Subduction } from "subduction_wasm"
 * import { SubductionStorageBridge } from "@automerge/automerge-repo-subduction-bridge"
 *
 * const storageAdapter = new IndexedDBStorageAdapter()
 * const storage = new SubductionStorageBridge(storageAdapter)
 * const subduction = await Subduction.hydrate(storage)
 * ```
 */

import type { StorageAdapterInterface } from "@automerge/automerge-repo"
import {
    type Storage,
    SedimentreeId,
    LooseCommit,
    Fragment,
    Digest,
    BlobMeta,
} from "@automerge/automerge_subduction"

/** Key prefix for all subduction data */
const PREFIX = "subduction"

/** Sub-prefixes for different data types */
const IDS_PREFIX = "ids"
const COMMITS_PREFIX = "commits"
const FRAGMENTS_PREFIX = "fragments"
const BLOBS_PREFIX = "blobs"

/** Marker value for sedimentree ID existence */
const ID_MARKER = new Uint8Array([1])

/**
 * Serialized representation of a LooseCommit for storage.
 */
interface SerializedLooseCommit {
    digest: string
    parents: string[]
    blobMeta: {
        digest: string
        sizeBytes: string // bigint as string
    }
}

/**
 * Serialized representation of a Fragment for storage.
 */
interface SerializedFragment {
    head: string
    boundary: string[]
    checkpoints: string[]
    blobMeta: {
        digest: string
        sizeBytes: string // bigint as string
    }
}

/**
 * Bridge that wraps an automerge-repo StorageAdapterInterface to implement
 * Subduction's Storage interface.
 *
 * This allows Subduction to use any existing automerge-repo storage adapter
 * (IndexedDB, NodeFS, etc.) as its backing store.
 */
export class SubductionStorageBridge implements Storage {
    private adapter: StorageAdapterInterface

    constructor(adapter: StorageAdapterInterface) {
        this.adapter = adapter
    }

    async saveSedimentreeId(sedimentreeId: SedimentreeId): Promise<void> {
        const key = [PREFIX, IDS_PREFIX, sedimentreeId.toString()]
        await this.adapter.save(key, ID_MARKER)
    }

    async deleteSedimentreeId(sedimentreeId: SedimentreeId): Promise<void> {
        const key = [PREFIX, IDS_PREFIX, sedimentreeId.toString()]
        await this.adapter.remove(key)
    }

    async loadAllSedimentreeIds(): Promise<SedimentreeId[]> {
        const chunks = await this.adapter.loadRange([PREFIX, IDS_PREFIX])
        const ids: SedimentreeId[] = []

        for (const chunk of chunks) {
            if (chunk.key.length === 3 && chunk.data) {
                const idHex = chunk.key[2]
                const bytes = hexToBytes(idHex)
                ids.push(SedimentreeId.fromBytes(bytes))
            }
        }

        return ids
    }

    async saveLooseCommit(
        sedimentreeId: SedimentreeId,
        commit: LooseCommit
    ): Promise<void> {
        const serialized: SerializedLooseCommit = {
            digest: commit.digest.toHexString(),
            parents: commit.parents.map(p => p.toHexString()),
            blobMeta: {
                digest: commit.blobMeta.digest().toHexString(),
                sizeBytes: commit.blobMeta.sizeBytes.toString(),
            },
        }

        const key = [
            PREFIX,
            COMMITS_PREFIX,
            sedimentreeId.toString(),
            commit.digest.toHexString(),
        ]
        const data = new TextEncoder().encode(JSON.stringify(serialized))
        await this.adapter.save(key, data)
    }

    async loadLooseCommits(
        sedimentreeId: SedimentreeId
    ): Promise<LooseCommit[]> {
        const chunks = await this.adapter.loadRange([
            PREFIX,
            COMMITS_PREFIX,
            sedimentreeId.toString(),
        ])
        const commits: LooseCommit[] = []

        for (const chunk of chunks) {
            if (!chunk.data) continue

            const json = new TextDecoder().decode(chunk.data)
            const serialized: SerializedLooseCommit = JSON.parse(json)

            const digest = Digest.fromHexString(serialized.digest)
            const parents = serialized.parents.map(p => Digest.fromHexString(p))

            const blobMetaDigest = Digest.fromHexString(
                serialized.blobMeta.digest
            )

            const blobMeta = BlobMeta.fromDigestSize(
                blobMetaDigest,
                BigInt(serialized.blobMeta.sizeBytes)
            )

            commits.push(new LooseCommit(digest, parents, blobMeta))
        }

        return commits
    }

    async deleteLooseCommits(sedimentreeId: SedimentreeId): Promise<void> {
        await this.adapter.removeRange([
            PREFIX,
            COMMITS_PREFIX,
            sedimentreeId.toString(),
        ])
    }

    async saveFragment(
        sedimentreeId: SedimentreeId,
        fragment: Fragment
    ): Promise<void> {
        const serialized: SerializedFragment = {
            head: fragment.head.toHexString(),
            boundary: fragment.boundary.map(b => b.toHexString()),
            checkpoints: fragment.checkpoints.map(c => c.toHexString()),
            blobMeta: {
                digest: fragment.blobMeta.digest().toHexString(),
                sizeBytes: fragment.blobMeta.sizeBytes.toString(),
            },
        }

        const key = [
            PREFIX,
            FRAGMENTS_PREFIX,
            sedimentreeId.toString(),
            fragment.head.toHexString(),
        ]
        const data = new TextEncoder().encode(JSON.stringify(serialized))
        await this.adapter.save(key, data)
    }

    async loadFragments(sedimentreeId: SedimentreeId): Promise<Fragment[]> {
        const chunks = await this.adapter.loadRange([
            PREFIX,
            FRAGMENTS_PREFIX,
            sedimentreeId.toString(),
        ])
        const fragments: Fragment[] = []

        for (const chunk of chunks) {
            if (!chunk.data) continue

            const json = new TextDecoder().decode(chunk.data)
            const serialized: SerializedFragment = JSON.parse(json)

            const head = Digest.fromHexString(serialized.head)

            const boundary = serialized.boundary.map(b =>
                Digest.fromHexString(b)
            )

            const checkpoints = serialized.checkpoints.map(c =>
                Digest.fromHexString(c)
            )

            const blobMetaDigest = Digest.fromHexString(
                serialized.blobMeta.digest
            )

            const blobMeta = BlobMeta.fromDigestSize(
                blobMetaDigest,
                BigInt(serialized.blobMeta.sizeBytes)
            )

            fragments.push(new Fragment(head, boundary, checkpoints, blobMeta))
        }

        return fragments
    }

    async deleteFragments(sedimentreeId: SedimentreeId): Promise<void> {
        await this.adapter.removeRange([
            PREFIX,
            FRAGMENTS_PREFIX,
            sedimentreeId.toString(),
        ])
    }

    async saveBlob(data: Uint8Array): Promise<Digest> {
        const digest = Digest.hash(data)
        const key = [PREFIX, BLOBS_PREFIX, digest.toHexString()]
        await this.adapter.save(key, data)
        return digest
    }

    async loadBlob(digest: Digest): Promise<Uint8Array | null> {
        const key = [PREFIX, BLOBS_PREFIX, digest.toHexString()]
        const data = await this.adapter.load(key)
        return data ?? null
    }

    async deleteBlob(digest: Digest): Promise<void> {
        const key = [PREFIX, BLOBS_PREFIX, digest.toHexString()]
        await this.adapter.remove(key)
    }
}

/**
 * Convert a hex string to Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    }
    return bytes
}
