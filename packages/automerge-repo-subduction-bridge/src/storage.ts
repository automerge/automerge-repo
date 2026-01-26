/**
 * Bridge that allows Subduction to use automerge-repo storage adapters.
 *
 * @example
 * ```ts
 * import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
 * import { Subduction } from "@automerge/automerge_subduction"
 * import { SubductionStorageBridge } from "@automerge/automerge-repo-subduction-bridge"
 *
 * const storageAdapter = new IndexedDBStorageAdapter("my-app-db")
 * const storage = new SubductionStorageBridge(storageAdapter)
 * const subduction = await Subduction.hydrate(storage)
 * ```
 */

import type { StorageAdapterInterface } from "@automerge/automerge-repo"
import {
    type SedimentreeStorage,
    SedimentreeId,
    LooseCommit,
    Fragment,
    Digest,
    BlobMeta,
} from "@automerge/automerge_subduction"

export interface StorageBridgeEvents {
    "commit-saved": (
        sedimentreeId: SedimentreeId,
        commit: LooseCommit,
        blob: Uint8Array
    ) => void

    "fragment-saved": (
        sedimentreeId: SedimentreeId,
        fragment: Fragment,
        blob: Uint8Array
    ) => void

    "blob-saved": (digest: Digest, blob: Uint8Array) => void
}

/**
 * Bridge that wraps an automerge-repo StorageAdapterInterface to implement
 * Subduction's Storage interface.
 *
 * This allows Subduction to use any existing automerge-repo storage adapter
 * (IndexedDB, NodeFS, etc.) as its backing store.
 *
 * Supports event callbacks via `on()` for commit-saved, fragment-saved, and blob-saved events.
 */
export class SubductionStorageBridge implements SedimentreeStorage {
    private adapter: StorageAdapterInterface
    private listeners: {
        [K in keyof StorageBridgeEvents]?: StorageBridgeEvents[K][]
    } = {}

    constructor(adapter: StorageAdapterInterface) {
        this.adapter = adapter
    }

    /**
     * Register an event listener.
     */
    on<K extends keyof StorageBridgeEvents>(
        event: K,
        callback: StorageBridgeEvents[K]
    ): void {
        if (!this.listeners[event]) {
            this.listeners[event] = []
        }
        this.listeners[event]!.push(callback)
    }

    /**
     * Remove an event listener.
     */
    off<K extends keyof StorageBridgeEvents>(
        event: K,
        callback: StorageBridgeEvents[K]
    ): void {
        const listeners = this.listeners[event]
        if (listeners) {
            const index = listeners.indexOf(callback)
            if (index !== -1) {
                listeners.splice(index, 1)
            }
        }
    }

    private emit<K extends keyof StorageBridgeEvents>(
        event: K,
        ...args: Parameters<StorageBridgeEvents[K]>
    ): void {
        this.listeners[event]?.forEach(listener =>
            (listener as (...args: Parameters<StorageBridgeEvents[K]>) => void)(
                ...args
            )
        )
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
        return chunks
            .filter(chunk => chunk.key.length === 3 && chunk.data)
            .map(chunk => SedimentreeId.fromBytes(hexToBytes(chunk.key[2])))
    }

    async saveLooseCommit(
        sedimentreeId: SedimentreeId,
        commit: LooseCommit
    ): Promise<void> {
        const key = [
            PREFIX,
            COMMITS_PREFIX,
            sedimentreeId.toString(),
            bytesToHex(commit.digest.toBytes()),
        ]
        await this.adapter.save(key, serializeLooseCommit(commit))

        // Emit event after save - load blob to include in event
        if (this.listeners["commit-saved"]?.length) {
            const blobDigest = commit.blobMeta.digest()
            const blob = await this.loadBlob(blobDigest)
            if (blob) {
                this.emit("commit-saved", sedimentreeId, commit, blob)
            }
        }
    }

    async loadLooseCommits(
        sedimentreeId: SedimentreeId
    ): Promise<LooseCommit[]> {
        const chunks = await this.adapter.loadRange([
            PREFIX,
            COMMITS_PREFIX,
            sedimentreeId.toString(),
        ])
        return chunks
            .filter(chunk => chunk.data)
            .map(chunk => deserializeLooseCommit(chunk.data!))
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
        const key = [
            PREFIX,
            FRAGMENTS_PREFIX,
            sedimentreeId.toString(),
            bytesToHex(fragment.head.toBytes()),
        ]
        await this.adapter.save(key, serializeFragment(fragment))

        // Emit event after save - load blob to include in event
        if (this.listeners["fragment-saved"]?.length) {
            const blobDigest = fragment.blobMeta.digest()
            const blob = await this.loadBlob(blobDigest)
            if (blob) {
                this.emit("fragment-saved", sedimentreeId, fragment, blob)
            }
        }
    }

    async loadFragments(sedimentreeId: SedimentreeId): Promise<Fragment[]> {
        const chunks = await this.adapter.loadRange([
            PREFIX,
            FRAGMENTS_PREFIX,
            sedimentreeId.toString(),
        ])
        return chunks
            .filter(chunk => chunk.data)
            .map(chunk => deserializeFragment(chunk.data!))
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
        const digestHex = bytesToHex(digest.toBytes())
        const key = [PREFIX, BLOBS_PREFIX, digestHex]
        await this.adapter.save(key, data)

        // Emit event after save
        if (this.listeners["blob-saved"]?.length) {
            this.emit("blob-saved", digest, data)
        }

        return digest
    }

    async loadBlob(digest: Digest): Promise<Uint8Array | null> {
        const digestHex = bytesToHex(digest.toBytes())
        const key = [PREFIX, BLOBS_PREFIX, digestHex]
        const data = await this.adapter.load(key)
        return data ?? null
    }

    async deleteBlob(digest: Digest): Promise<void> {
        const key = [PREFIX, BLOBS_PREFIX, bytesToHex(digest.toBytes())]
        await this.adapter.remove(key)
    }
}

const DIGEST_SIZE_BYTES = 32
const PREFIX = "subduction"
const IDS_PREFIX = "ids"
const COMMITS_PREFIX = "commits"
const FRAGMENTS_PREFIX = "fragments"
const BLOBS_PREFIX = "blobs"

/** Marker value for sedimentree ID existence */
const ID_MARKER = new Uint8Array([1])

const concatBytes = (...arrays: Uint8Array[]): Uint8Array => {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
    const result = new Uint8Array(totalLength)
    arrays.reduce(
        (offset, arr) => (result.set(arr, offset), offset + arr.length),
        0
    )
    return result
}

const toUint8Array = (n: number): Uint8Array => new Uint8Array([n])

const bigUint64Bytes = (n: bigint): Uint8Array => {
    const buffer = new Uint8Array(8)
    new DataView(buffer.buffer).setBigUint64(0, n)
    return buffer
}

/**
 * Serialize a LooseCommit to binary format.
 * Format: [8 size][32 digest][1 num_parents][32*n parents][32 blob_digest]
 */
const serializeLooseCommit = (commit: LooseCommit): Uint8Array =>
    concatBytes(
        bigUint64Bytes(commit.blobMeta.sizeBytes),
        commit.digest.toBytes(),
        toUint8Array(commit.parents.length),
        ...commit.parents.map(p => p.toBytes()),
        commit.blobMeta.digest().toBytes()
    )

/**
 * Deserialize a LooseCommit from binary format.
 */
const deserializeLooseCommit = (buffer: Uint8Array): LooseCommit => {
    const view = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength
    )

    const sizeBytes = view.getBigUint64(0)
    const digestOffset = 8
    const digest = Digest.fromBytes(
        buffer.slice(digestOffset, digestOffset + DIGEST_SIZE_BYTES)
    )
    const numParents = buffer[digestOffset + DIGEST_SIZE_BYTES]
    const parentsOffset = digestOffset + DIGEST_SIZE_BYTES + 1

    const parents = Array.from({ length: numParents }, (_, i) =>
        Digest.fromBytes(
            buffer.slice(
                parentsOffset + i * DIGEST_SIZE_BYTES,
                parentsOffset + (i + 1) * DIGEST_SIZE_BYTES
            )
        )
    )

    const blobDigestOffset = parentsOffset + numParents * DIGEST_SIZE_BYTES
    const blobDigest = Digest.fromBytes(
        buffer.slice(blobDigestOffset, blobDigestOffset + DIGEST_SIZE_BYTES)
    )

    const blobMeta = BlobMeta.fromDigestSize(blobDigest, sizeBytes)

    return new LooseCommit(digest, parents, blobMeta)
}

/**
 * Serialize a Fragment to binary format.
 * Format: [8 size][32 head][1 num_boundary][32*n boundary][1 num_checkpoints][32*m checkpoints][32 blob_digest]
 */
const serializeFragment = (fragment: Fragment): Uint8Array =>
    concatBytes(
        bigUint64Bytes(fragment.blobMeta.sizeBytes),
        fragment.head.toBytes(),
        toUint8Array(fragment.boundary.length),
        ...fragment.boundary.map(b => b.toBytes()),
        toUint8Array(fragment.checkpoints.length),
        ...fragment.checkpoints.map(c => c.toBytes()),
        fragment.blobMeta.digest().toBytes()
    )

/**
 * Deserialize a Fragment from binary format.
 */
const deserializeFragment = (buffer: Uint8Array): Fragment => {
    const view = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength
    )

    const sizeBytes = view.getBigUint64(0)
    const headOffset = 8
    const head = Digest.fromBytes(
        buffer.slice(headOffset, headOffset + DIGEST_SIZE_BYTES)
    )
    const numBoundary = buffer[headOffset + DIGEST_SIZE_BYTES]
    const boundaryOffset = headOffset + DIGEST_SIZE_BYTES + 1

    const boundary = Array.from({ length: numBoundary }, (_, i) =>
        Digest.fromBytes(
            buffer.slice(
                boundaryOffset + i * DIGEST_SIZE_BYTES,
                boundaryOffset + (i + 1) * DIGEST_SIZE_BYTES
            )
        )
    )

    const numCheckpointsOffset =
        boundaryOffset + numBoundary * DIGEST_SIZE_BYTES
    const numCheckpoints = buffer[numCheckpointsOffset]
    const checkpointsOffset = numCheckpointsOffset + 1

    const checkpoints = Array.from({ length: numCheckpoints }, (_, i) =>
        Digest.fromBytes(
            buffer.slice(
                checkpointsOffset + i * DIGEST_SIZE_BYTES,
                checkpointsOffset + (i + 1) * DIGEST_SIZE_BYTES
            )
        )
    )

    const blobDigestOffset =
        checkpointsOffset + numCheckpoints * DIGEST_SIZE_BYTES
    const blobDigest = Digest.fromBytes(
        buffer.slice(blobDigestOffset, blobDigestOffset + DIGEST_SIZE_BYTES)
    )

    const blobMeta = BlobMeta.fromDigestSize(blobDigest, sizeBytes)

    return new Fragment(head, boundary, checkpoints, blobMeta)
}

/**
 * Convert a hex string to Uint8Array.
 */
const hexToBytes = (hex: string): Uint8Array =>
    Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
        parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    )

/**
 * Convert Uint8Array to hex string.
 */
const bytesToHex = (bytes: Uint8Array): string =>
    Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
