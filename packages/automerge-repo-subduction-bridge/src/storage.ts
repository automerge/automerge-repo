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
    Digest,
} from "@automerge/automerge_subduction"

export interface StorageBridgeEvents {
    /**
     * Emitted when a commit is saved.
     * The blob is the Automerge change data (loaded via the digest).
     */
    "commit-saved": (
        sedimentreeId: SedimentreeId,
        digest: Digest,
        blob: Uint8Array
    ) => void

    /**
     * Emitted when a fragment is saved.
     * The blob is the Automerge bundle data (loaded via the fragment's blob digest).
     */
    "fragment-saved": (
        sedimentreeId: SedimentreeId,
        digest: Digest,
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
 * ## Storage Format
 *
 * Commits and fragments are stored as CBOR-encoded `Signed<T>` bytes:
 * - The WASM layer handles encoding/decoding
 * - The bridge stores opaque `Uint8Array` blobs keyed by digest
 * - Content-addressed storage (CAS) pattern for all data types
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

    // ==================== Sedimentree IDs ====================

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

    // ==================== Commits (CAS) ====================

    async saveCommit(
        sedimentreeId: SedimentreeId,
        digest: Digest,
        signedCommit: Uint8Array,
        blobDigest: Digest
    ): Promise<void> {
        const key = [
            PREFIX,
            COMMITS_PREFIX,
            sedimentreeId.toString(),
            bytesToHex(digest.toBytes()),
        ]
        await this.adapter.save(key, signedCommit)

        // Emit event after save - load blob to include in event
        if (this.listeners["commit-saved"]?.length) {
            const blob = await this.loadBlob(blobDigest)
            if (blob) {
                this.emit("commit-saved", sedimentreeId, digest, blob)
            }
        }
    }

    async loadCommit(
        sedimentreeId: SedimentreeId,
        digest: Digest
    ): Promise<Uint8Array | null> {
        const key = [
            PREFIX,
            COMMITS_PREFIX,
            sedimentreeId.toString(),
            bytesToHex(digest.toBytes()),
        ]
        const data = await this.adapter.load(key)
        return data ?? null
    }

    async listCommitDigests(sedimentreeId: SedimentreeId): Promise<Digest[]> {
        const chunks = await this.adapter.loadRange([
            PREFIX,
            COMMITS_PREFIX,
            sedimentreeId.toString(),
        ])
        return chunks
            .filter(chunk => chunk.key.length === 4 && chunk.data)
            .map(chunk => Digest.fromBytes(hexToBytes(chunk.key[3])))
    }

    async loadAllCommits(
        sedimentreeId: SedimentreeId
    ): Promise<Array<{ digest: Digest; signed: Uint8Array }>> {
        const chunks = await this.adapter.loadRange([
            PREFIX,
            COMMITS_PREFIX,
            sedimentreeId.toString(),
        ])
        return chunks
            .filter(chunk => chunk.key.length === 4 && chunk.data)
            .map(chunk => ({
                digest: Digest.fromBytes(hexToBytes(chunk.key[3])),
                signed: chunk.data!,
            }))
    }

    async deleteCommit(
        sedimentreeId: SedimentreeId,
        digest: Digest
    ): Promise<void> {
        const key = [
            PREFIX,
            COMMITS_PREFIX,
            sedimentreeId.toString(),
            bytesToHex(digest.toBytes()),
        ]
        await this.adapter.remove(key)
    }

    async deleteAllCommits(sedimentreeId: SedimentreeId): Promise<void> {
        await this.adapter.removeRange([
            PREFIX,
            COMMITS_PREFIX,
            sedimentreeId.toString(),
        ])
    }

    // ==================== Fragments (CAS) ====================

    async saveFragment(
        sedimentreeId: SedimentreeId,
        digest: Digest,
        signedFragment: Uint8Array,
        blobDigest: Digest
    ): Promise<void> {
        const key = [
            PREFIX,
            FRAGMENTS_PREFIX,
            sedimentreeId.toString(),
            bytesToHex(digest.toBytes()),
        ]
        await this.adapter.save(key, signedFragment)

        // Emit event after save - load blob to include in event
        if (this.listeners["fragment-saved"]?.length) {
            const blob = await this.loadBlob(blobDigest)
            if (blob) {
                this.emit("fragment-saved", sedimentreeId, digest, blob)
            }
        }
    }

    async loadFragment(
        sedimentreeId: SedimentreeId,
        digest: Digest
    ): Promise<Uint8Array | null> {
        const key = [
            PREFIX,
            FRAGMENTS_PREFIX,
            sedimentreeId.toString(),
            bytesToHex(digest.toBytes()),
        ]
        const data = await this.adapter.load(key)
        return data ?? null
    }

    async listFragmentDigests(sedimentreeId: SedimentreeId): Promise<Digest[]> {
        const chunks = await this.adapter.loadRange([
            PREFIX,
            FRAGMENTS_PREFIX,
            sedimentreeId.toString(),
        ])
        return chunks
            .filter(chunk => chunk.key.length === 4 && chunk.data)
            .map(chunk => Digest.fromBytes(hexToBytes(chunk.key[3])))
    }

    async loadAllFragments(
        sedimentreeId: SedimentreeId
    ): Promise<Array<{ digest: Digest; signed: Uint8Array }>> {
        const chunks = await this.adapter.loadRange([
            PREFIX,
            FRAGMENTS_PREFIX,
            sedimentreeId.toString(),
        ])
        return chunks
            .filter(chunk => chunk.key.length === 4 && chunk.data)
            .map(chunk => ({
                digest: Digest.fromBytes(hexToBytes(chunk.key[3])),
                signed: chunk.data!,
            }))
    }

    async deleteFragment(
        sedimentreeId: SedimentreeId,
        digest: Digest
    ): Promise<void> {
        const key = [
            PREFIX,
            FRAGMENTS_PREFIX,
            sedimentreeId.toString(),
            bytesToHex(digest.toBytes()),
        ]
        await this.adapter.remove(key)
    }

    async deleteAllFragments(sedimentreeId: SedimentreeId): Promise<void> {
        await this.adapter.removeRange([
            PREFIX,
            FRAGMENTS_PREFIX,
            sedimentreeId.toString(),
        ])
    }

    // ==================== Blobs (CAS) ====================

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

const PREFIX = "subduction"
const IDS_PREFIX = "ids"
const COMMITS_PREFIX = "commits"
const FRAGMENTS_PREFIX = "fragments"
const BLOBS_PREFIX = "blobs"

/** Marker value for sedimentree ID existence */
const ID_MARKER = new Uint8Array([1])

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
