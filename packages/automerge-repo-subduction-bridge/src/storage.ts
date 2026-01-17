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
    type Storage,
    SedimentreeId,
    LooseCommit,
    Fragment,
    Digest,
    BlobMeta,
} from "@automerge/automerge_subduction"

/** Digest size in bytes */
const DIGEST_SIZE = 32

/** Key prefix for all subduction data */
const PREFIX = "subduction"

/** Sub-prefixes for different data types */
const IDS_PREFIX = "ids"
const COMMITS_PREFIX = "commits"
const FRAGMENTS_PREFIX = "fragments"
const BLOBS_PREFIX = "blobs"

/** Marker value for sedimentree ID existence */
const ID_MARKER = new Uint8Array([1])

// ============================================================================
// Binary Serialization
// ============================================================================

/**
 * Serialize a LooseCommit to binary format.
 * Format: [32 digest][1 num_parents][32*n parents][32 blob_digest][8 size]
 */
function serializeLooseCommit(commit: LooseCommit): Uint8Array {
    const numParents = commit.parents.length
    const size = DIGEST_SIZE + 1 + (numParents * DIGEST_SIZE) + DIGEST_SIZE + 8
    const buffer = new Uint8Array(size)
    const view = new DataView(buffer.buffer)
    let offset = 0

    buffer.set(commit.digest.toBytes(), offset)
    offset += DIGEST_SIZE

    buffer[offset++] = numParents
    for (const parent of commit.parents) {
        buffer.set(parent.toBytes(), offset)
        offset += DIGEST_SIZE
    }

    buffer.set(commit.blobMeta.digest().toBytes(), offset)
    offset += DIGEST_SIZE

    view.setBigUint64(offset, commit.blobMeta.sizeBytes)

    return buffer
}

/**
 * Deserialize a LooseCommit from binary format.
 */
function deserializeLooseCommit(buffer: Uint8Array): LooseCommit {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    let offset = 0

    const digest = Digest.fromBytes(buffer.slice(offset, offset + DIGEST_SIZE))
    offset += DIGEST_SIZE

    const numParents = buffer[offset++]
    const parents: Digest[] = []
    for (let i = 0; i < numParents; i++) {
        parents.push(Digest.fromBytes(buffer.slice(offset, offset + DIGEST_SIZE)))
        offset += DIGEST_SIZE
    }

    const blobDigest = Digest.fromBytes(buffer.slice(offset, offset + DIGEST_SIZE))
    offset += DIGEST_SIZE

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
    const size = DIGEST_SIZE + 1 + (numBoundary * DIGEST_SIZE) + 1 + (numCheckpoints * DIGEST_SIZE) + DIGEST_SIZE + 8
    const buffer = new Uint8Array(size)
    const view = new DataView(buffer.buffer)
    let offset = 0

    buffer.set(fragment.head.toBytes(), offset)
    offset += DIGEST_SIZE

    buffer[offset++] = numBoundary
    for (const b of fragment.boundary) {
        buffer.set(b.toBytes(), offset)
        offset += DIGEST_SIZE
    }

    buffer[offset++] = numCheckpoints
    for (const c of fragment.checkpoints) {
        buffer.set(c.toBytes(), offset)
        offset += DIGEST_SIZE
    }

    buffer.set(fragment.blobMeta.digest().toBytes(), offset)
    offset += DIGEST_SIZE

    view.setBigUint64(offset, fragment.blobMeta.sizeBytes)

    return buffer
}

/**
 * Deserialize a Fragment from binary format.
 */
function deserializeFragment(buffer: Uint8Array): Fragment {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    let offset = 0

    const head = Digest.fromBytes(buffer.slice(offset, offset + DIGEST_SIZE))
    offset += DIGEST_SIZE

    const numBoundary = buffer[offset++]
    const boundary: Digest[] = []
    for (let i = 0; i < numBoundary; i++) {
        boundary.push(Digest.fromBytes(buffer.slice(offset, offset + DIGEST_SIZE)))
        offset += DIGEST_SIZE
    }

    const numCheckpoints = buffer[offset++]
    const checkpoints: Digest[] = []
    for (let i = 0; i < numCheckpoints; i++) {
        checkpoints.push(Digest.fromBytes(buffer.slice(offset, offset + DIGEST_SIZE)))
        offset += DIGEST_SIZE
    }

    const blobDigest = Digest.fromBytes(buffer.slice(offset, offset + DIGEST_SIZE))
    offset += DIGEST_SIZE

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

// ============================================================================
// Storage Bridge Events
// ============================================================================

export interface StorageBridgeEvents {
    "commit-saved": (sedimentreeId: SedimentreeId, commit: LooseCommit, blob: Uint8Array) => void
    "fragment-saved": (sedimentreeId: SedimentreeId, fragment: Fragment, blob: Uint8Array) => void
    "blob-saved": (digest: Digest, blob: Uint8Array) => void
}

// ============================================================================
// Storage Bridge
// ============================================================================

/**
 * Bridge that wraps an automerge-repo StorageAdapterInterface to implement
 * Subduction's Storage interface.
 *
 * This allows Subduction to use any existing automerge-repo storage adapter
 * (IndexedDB, NodeFS, etc.) as its backing store.
 *
 * Supports event callbacks via `on()` for commit-saved, fragment-saved, and blob-saved events.
 */
export class SubductionStorageBridge implements Storage {
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
    on<K extends keyof StorageBridgeEvents>(event: K, callback: StorageBridgeEvents[K]): void {
        if (!this.listeners[event]) {
            this.listeners[event] = []
        }
        this.listeners[event]!.push(callback)
    }

    /**
     * Remove an event listener.
     */
    off<K extends keyof StorageBridgeEvents>(event: K, callback: StorageBridgeEvents[K]): void {
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
                (listener as (...args: Parameters<StorageBridgeEvents[K]>) => void)(...args)
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
        const startTime = Date.now()
        const key = [
            PREFIX,
            COMMITS_PREFIX,
            sedimentreeId.toString(),
            bytesToHex(commit.digest.toBytes()),
        ]
        console.log(`[${startTime}] Storage bridge: saveLooseCommit START, sedimentreeId: ${sedimentreeId.toString()}`)
        await this.adapter.save(key, serializeLooseCommit(commit))
        const afterSaveTime = Date.now()
        console.log(`[${afterSaveTime}] Storage bridge: saveLooseCommit saved metadata, took ${afterSaveTime - startTime}ms`)

        // Emit event after save - load blob to include in event
        if (this.listeners["commit-saved"]?.length) {
            const blobDigest = commit.blobMeta.digest()
            const expectedDigestHex = bytesToHex(blobDigest.toBytes())
            console.log(`[${Date.now()}] Storage bridge: commit saved, attempting to load blob with digest: ${expectedDigestHex}`)

            // DEBUG: Try microtask delay to see if IndexedDB needs time to flush
            await new Promise(resolve => setTimeout(resolve, 0))
            const afterDelayTime = Date.now()
            console.log(`[${afterDelayTime}] Storage bridge: after microtask delay, now loading blob`)

            const blob = await this.loadBlob(blobDigest)
            const afterLoadTime = Date.now()

            if (blob) {
                console.log(`[${afterLoadTime}] Storage bridge: blob FOUND, size: ${blob.length}, emitting commit-saved event`)
                this.emit("commit-saved", sedimentreeId, commit, blob)
            } else {
                console.log(`[${afterLoadTime}] Storage bridge: blob NOT FOUND for digest ${expectedDigestHex}!`)
                console.log(`[${afterLoadTime}] Storage bridge: This indicates a digest mismatch or IndexedDB timing issue`)
            }
        } else {
            console.log(`[${Date.now()}] Storage bridge: no commit-saved listeners registered`)
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
        const startTime = Date.now()
        const key = [
            PREFIX,
            FRAGMENTS_PREFIX,
            sedimentreeId.toString(),
            bytesToHex(fragment.head.toBytes()),
        ]
        console.log(`[${startTime}] Storage bridge: saveFragment START, sedimentreeId: ${sedimentreeId.toString()}`)
        await this.adapter.save(key, serializeFragment(fragment))
        const afterSaveTime = Date.now()
        console.log(`[${afterSaveTime}] Storage bridge: saveFragment saved metadata, took ${afterSaveTime - startTime}ms`)

        // Emit event after save - load blob to include in event
        if (this.listeners["fragment-saved"]?.length) {
            const blobDigest = fragment.blobMeta.digest()
            const expectedDigestHex = bytesToHex(blobDigest.toBytes())
            console.log(`[${Date.now()}] Storage bridge: fragment saved, attempting to load blob with digest: ${expectedDigestHex}`)

            // DEBUG: Try microtask delay to see if IndexedDB needs time to flush
            await new Promise(resolve => setTimeout(resolve, 0))
            console.log(`[${Date.now()}] Storage bridge: after microtask delay, now loading blob for fragment`)

            const blob = await this.loadBlob(blobDigest)
            const afterLoadTime = Date.now()

            if (blob) {
                console.log(`[${afterLoadTime}] Storage bridge: fragment blob FOUND, size: ${blob.length}, emitting fragment-saved event`)
                this.emit("fragment-saved", sedimentreeId, fragment, blob)
            } else {
                console.log(`[${afterLoadTime}] Storage bridge: fragment blob NOT FOUND for digest ${expectedDigestHex}!`)
            }
        } else {
            console.log(`[${Date.now()}] Storage bridge: no fragment-saved listeners registered`)
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
        const startTime = Date.now()
        const digest = Digest.hash(data)
        const digestHex = bytesToHex(digest.toBytes())
        console.log(`[${startTime}] Storage bridge: saveBlob START, digest: ${digestHex}, size: ${data.length}`)
        const key = [PREFIX, BLOBS_PREFIX, digestHex]
        await this.adapter.save(key, data)
        const endTime = Date.now()
        console.log(`[${endTime}] Storage bridge: saveBlob END, digest: ${digestHex}, took ${endTime - startTime}ms`)

        // Emit event after save
        if (this.listeners["blob-saved"]?.length) {
            this.emit("blob-saved", digest, data)
        }

        return digest
    }

    async loadBlob(digest: Digest): Promise<Uint8Array | null> {
        const digestHex = bytesToHex(digest.toBytes())
        const key = [PREFIX, BLOBS_PREFIX, digestHex]
        console.log(`[${Date.now()}] Storage bridge: loadBlob called for digest: ${digestHex}`)
        const data = await this.adapter.load(key)
        console.log(`[${Date.now()}] Storage bridge: loadBlob result for ${digestHex}: ${data ? `FOUND (${data.length} bytes)` : 'NOT FOUND'}`)
        return data ?? null
    }

    async deleteBlob(digest: Digest): Promise<void> {
        const key = [PREFIX, BLOBS_PREFIX, bytesToHex(digest.toBytes())]
        await this.adapter.remove(key)
    }
}
