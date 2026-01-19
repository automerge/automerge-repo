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
    type SubductionStorage,
    SedimentreeId,
    LooseCommit,
    Fragment,
    Digest,
    BlobMeta,
} from "@automerge/automerge_subduction"

const DIGEST_SIZE_BYTES = 32
const PREFIX = "subduction"
const IDS_PREFIX = "ids"
const COMMITS_PREFIX = "commits"
const FRAGMENTS_PREFIX = "fragments"
const BLOBS_PREFIX = "blobs"

/** Marker value for sedimentree ID existence */
const ID_MARKER = new Uint8Array([1])

/**
 * Serialize a LooseCommit to binary format.
 * Format: [32 digest][1 num_parents][32*n parents][32 blob_digest][8 size]
 */
function serializeLooseCommit(commit: LooseCommit): Uint8Array {
    const numParents = commit.parents.length
    const size =
        DIGEST_SIZE_BYTES +
        1 +
        numParents * DIGEST_SIZE_BYTES +
        DIGEST_SIZE_BYTES +
        8
    const buffer = new Uint8Array(size)
    const view = new DataView(buffer.buffer)
    let offset = 0

    buffer.set(commit.digest.toBytes(), offset)
    offset += DIGEST_SIZE_BYTES

    buffer[offset++] = numParents
    for (const parent of commit.parents) {
        buffer.set(parent.toBytes(), offset)
        offset += DIGEST_SIZE_BYTES
    }

    buffer.set(commit.blobMeta.digest().toBytes(), offset)
    offset += DIGEST_SIZE_BYTES

    view.setBigUint64(offset, commit.blobMeta.sizeBytes)

    return buffer
}

/**
 * Deserialize a LooseCommit from binary format.
 */
function deserializeLooseCommit(buffer: Uint8Array): LooseCommit {
    const view = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength
    )
    let offset = 0

    const digest = Digest.fromBytes(
        buffer.slice(offset, offset + DIGEST_SIZE_BYTES)
    )
    offset += DIGEST_SIZE_BYTES

    const numParents = buffer[offset++]
    const parents: Digest[] = []
    for (let i = 0; i < numParents; i++) {
        parents.push(
            Digest.fromBytes(buffer.slice(offset, offset + DIGEST_SIZE_BYTES))
        )
        offset += DIGEST_SIZE_BYTES
    }

    const blobDigest = Digest.fromBytes(
        buffer.slice(offset, offset + DIGEST_SIZE_BYTES)
    )
    offset += DIGEST_SIZE_BYTES

    const sizeBytes = view.getBigUint64(offset)

    const blobMeta = BlobMeta.fromDigestSize(blobDigest, sizeBytes)
    return new LooseCommit(digest, parents, blobMeta)
}

/**
 * Serialize a Fragment to binary format.
 * Format: [32 head][1 num_boundary][32*n boundary][1 num_checkpoints][32*m checkpoints][32 blob_digest][8 size]
 */
function serializeFragment(fragment: Fragment): Uint8Array {
    const numBoundary = fragment.boundary.length
    const numCheckpoints = fragment.checkpoints.length
    const size =
        DIGEST_SIZE_BYTES +
        1 +
        numBoundary * DIGEST_SIZE_BYTES +
        1 +
        numCheckpoints * DIGEST_SIZE_BYTES +
        DIGEST_SIZE_BYTES +
        8
    const buffer = new Uint8Array(size)
    const view = new DataView(buffer.buffer)
    let offset = 0

    buffer.set(fragment.head.toBytes(), offset)
    offset += DIGEST_SIZE_BYTES

    buffer[offset++] = numBoundary
    for (const b of fragment.boundary) {
        buffer.set(b.toBytes(), offset)
        offset += DIGEST_SIZE_BYTES
    }

    buffer[offset++] = numCheckpoints
    for (const c of fragment.checkpoints) {
        buffer.set(c.toBytes(), offset)
        offset += DIGEST_SIZE_BYTES
    }

    buffer.set(fragment.blobMeta.digest().toBytes(), offset)
    offset += DIGEST_SIZE_BYTES

    view.setBigUint64(offset, fragment.blobMeta.sizeBytes)

    return buffer
}

/**
 * Deserialize a Fragment from binary format.
 */
function deserializeFragment(buffer: Uint8Array): Fragment {
    const view = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength
    )
    let offset = 0

    const head = Digest.fromBytes(
        buffer.slice(offset, offset + DIGEST_SIZE_BYTES)
    )
    offset += DIGEST_SIZE_BYTES

    const numBoundary = buffer[offset++]
    const boundary: Digest[] = []
    for (let i = 0; i < numBoundary; i++) {
        boundary.push(
            Digest.fromBytes(buffer.slice(offset, offset + DIGEST_SIZE_BYTES))
        )
        offset += DIGEST_SIZE_BYTES
    }

    const numCheckpoints = buffer[offset++]
    const checkpoints: Digest[] = []
    for (let i = 0; i < numCheckpoints; i++) {
        checkpoints.push(
            Digest.fromBytes(buffer.slice(offset, offset + DIGEST_SIZE_BYTES))
        )
        offset += DIGEST_SIZE_BYTES
    }

    const blobDigest = Digest.fromBytes(
        buffer.slice(offset, offset + DIGEST_SIZE_BYTES)
    )
    offset += DIGEST_SIZE_BYTES

    const sizeBytes = view.getBigUint64(offset)

    const blobMeta = BlobMeta.fromDigestSize(blobDigest, sizeBytes)
    return new Fragment(head, boundary, checkpoints, blobMeta)
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

/**
 * Convert Uint8Array to hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
    let hex = ""
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, "0")
    }
    return hex
}

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
export class SubductionStorageBridge implements SubductionStorage {
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
        const listeners = this.listeners[event]
        if (listeners) {
            for (const listener of listeners) {
                ;(
                    listener as (
                        ...args: Parameters<StorageBridgeEvents[K]>
                    ) => void
                )(...args)
            }
        }
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
        const commits: LooseCommit[] = []

        for (const chunk of chunks) {
            if (!chunk.data) continue
            commits.push(deserializeLooseCommit(chunk.data))
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
        const fragments: Fragment[] = []

        for (const chunk of chunks) {
            if (!chunk.data) continue
            fragments.push(deserializeFragment(chunk.data))
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
