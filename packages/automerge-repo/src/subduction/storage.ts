/**
 * Bridge that allows Subduction to use automerge-repo storage adapters.
 *
 * @example
 * ```ts
 * import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
 * import { Subduction } from "@automerge/automerge-subduction"
 * import { SubductionStorageBridge } from "@automerge/automerge-repo-subduction-bridge"
 *
 * const storageAdapter = new IndexedDBStorageAdapter("my-app-db")
 * const storage = new SubductionStorageBridge(storageAdapter)
 * const subduction = await Subduction.hydrate(signer, storage)
 * ```
 */

import type { StorageAdapterInterface } from "@automerge/automerge-repo"
// Type-only imports (don't trigger Wasm access)
import type { SedimentreeStorage } from "@automerge/automerge-subduction/slim"
import {
  CommitWithBlob,
  Digest,
  FragmentWithBlob,
  SedimentreeId,
  SignedLooseCommit,
  SignedFragment,
} from "@automerge/automerge-subduction/slim"

export interface StorageBridgeEvents {
  /**
   * Emitted when a commit is saved.
   * The blob is the Automerge change data.
   */
  "commit-saved": (
    sedimentreeId: SedimentreeId,
    digest: Digest,
    blob: Uint8Array
  ) => void

  /**
   * Emitted when a fragment is saved.
   * The blob is the Automerge bundle data.
   */
  "fragment-saved": (
    sedimentreeId: SedimentreeId,
    digest: Digest,
    blob: Uint8Array
  ) => void
}

/**
 * Bridge that wraps an automerge-repo StorageAdapterInterface to implement
 * Subduction's SedimentreeStorage interface.
 *
 * This allows Subduction to use any existing automerge-repo storage adapter
 * (IndexedDB, NodeFS, etc.) as its backing store.
 *
 * ## Storage Format
 *
 * Commits and fragments are stored with their blobs:
 * - Signed commit/fragment bytes stored under commits/fragments prefix
 * - Blob bytes stored alongside under blobs prefix
 * - Content-addressed storage (CAS) pattern for all data types
 *
 * Supports event callbacks via `on()` for commit-saved, fragment-saved, and blob-saved events.
 */
export class SubductionStorageBridge implements SedimentreeStorage {
  private adapter: StorageAdapterInterface
  private listeners: {
    [K in keyof StorageBridgeEvents]?: StorageBridgeEvents[K][]
  } = {}
  private pendingSaves = 0
  private settleResolvers: (() => void)[] = []

  constructor(adapter: StorageAdapterInterface) {
    this.adapter = adapter
  }

  /**
   * Wait for all pending save operations to complete.
   * Useful for ensuring sync operations have fully persisted.
   */
  async awaitSettled(): Promise<void> {
    if (this.pendingSaves === 0) return
    return new Promise(r => this.settleResolvers.push(r))
  }

  private decrementPending(): void {
    this.pendingSaves--
    if (this.pendingSaves === 0) {
      this.settleResolvers.forEach(r => r())
      this.settleResolvers = []
    }
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

  // ==================== Commits (compound storage with blob) ====================

  async saveCommit(
    sedimentreeId: SedimentreeId,
    digest: Digest,
    signedCommit: SignedLooseCommit,
    blob: Uint8Array
  ): Promise<void> {
    // Encode the signed commit to bytes
    const commitBytes = signedCommit.encode()
    // Copy bytes from WASM memory view BEFORE any async operations
    const commitCopy = new Uint8Array(commitBytes)
    const blobCopy = new Uint8Array(blob)

    this.pendingSaves++
    try {
      const digestHex = digest.toHexString()
      const sid = sedimentreeId.toString()
      const commitKey = [PREFIX, COMMITS_PREFIX, sid, digestHex]
      const blobKey = [PREFIX, BLOBS_PREFIX, sid, digestHex]

      if (this.adapter.saveBatch) {
        await this.adapter.saveBatch([
          [commitKey, commitCopy],
          [blobKey, blobCopy],
        ])
      } else {
        await Promise.all([
          this.adapter.save(commitKey, commitCopy),
          this.adapter.save(blobKey, blobCopy),
        ])
      }

      // Emit event after save
      if (this.listeners["commit-saved"]?.length) {
        this.emit("commit-saved", sedimentreeId, digest, blobCopy)
      }
    } finally {
      this.decrementPending()
    }
  }

  async loadCommit(
    sedimentreeId: SedimentreeId,
    digest: Digest
  ): Promise<CommitWithBlob | null> {
    const digestHex = digest.toHexString()
    const sid = sedimentreeId.toString()
    const commitKey = [PREFIX, COMMITS_PREFIX, sid, digestHex]
    const blobKey = [PREFIX, BLOBS_PREFIX, sid, digestHex]

    const [commitData, blobData] = await Promise.all([
      this.adapter.load(commitKey),
      this.adapter.load(blobKey),
    ])

    if (!commitData || !blobData) return null

    const signedCommit = SignedLooseCommit.tryDecode(commitData)
    return new CommitWithBlob(signedCommit, blobData)
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
  ): Promise<CommitWithBlob[]> {
    const sid = sedimentreeId.toString()
    // Batch: two loadRange calls in parallel instead of 1 + 2N sequential loads.
    const [commitChunks, blobChunks] = await Promise.all([
      this.adapter.loadRange([PREFIX, COMMITS_PREFIX, sid]),
      this.adapter.loadRange([PREFIX, BLOBS_PREFIX, sid]),
    ])

    // Index blobs by digest hex for O(1) lookup
    const blobsByDigest = new Map<string, Uint8Array>()
    for (const chunk of blobChunks) {
      if (chunk.key.length === 4 && chunk.data) {
        blobsByDigest.set(chunk.key[3], chunk.data)
      }
    }

    const results: CommitWithBlob[] = []
    for (const chunk of commitChunks) {
      if (chunk.key.length !== 4 || !chunk.data) continue
      const digestHex = chunk.key[3]
      const blobData = blobsByDigest.get(digestHex)
      if (!blobData) continue

      const signedCommit = SignedLooseCommit.tryDecode(chunk.data)
      results.push(new CommitWithBlob(signedCommit, blobData))
    }

    return results
  }

  async deleteCommit(
    sedimentreeId: SedimentreeId,
    digest: Digest
  ): Promise<void> {
    const digestHex = digest.toHexString()
    const sid = sedimentreeId.toString()
    const commitKey = [PREFIX, COMMITS_PREFIX, sid, digestHex]
    const blobKey = [PREFIX, BLOBS_PREFIX, sid, digestHex]

    await Promise.all([
      this.adapter.remove(commitKey),
      this.adapter.remove(blobKey),
    ])
  }

  async deleteAllCommits(sedimentreeId: SedimentreeId): Promise<void> {
    const sid = sedimentreeId.toString()
    await Promise.all([
      this.adapter.removeRange([PREFIX, COMMITS_PREFIX, sid]),
      this.adapter.removeRange([PREFIX, BLOBS_PREFIX, sid]),
    ])
  }

  // ==================== Fragments (compound storage with blob) ====================

  async saveFragment(
    sedimentreeId: SedimentreeId,
    digest: Digest,
    signedFragment: SignedFragment,
    blob: Uint8Array
  ): Promise<void> {
    // Encode the signed fragment to bytes
    const fragmentBytes = signedFragment.encode()
    // Copy bytes from WASM memory view BEFORE any async operations
    const fragmentCopy = new Uint8Array(fragmentBytes)
    const blobCopy = new Uint8Array(blob)

    this.pendingSaves++
    try {
      const digestHex = digest.toHexString()
      const sid = sedimentreeId.toString()
      const fragmentKey = [PREFIX, FRAGMENTS_PREFIX, sid, digestHex]
      const blobKey = [PREFIX, FRAGMENT_BLOBS_PREFIX, sid, digestHex]

      if (this.adapter.saveBatch) {
        await this.adapter.saveBatch([
          [fragmentKey, fragmentCopy],
          [blobKey, blobCopy],
        ])
      } else {
        await Promise.all([
          this.adapter.save(fragmentKey, fragmentCopy),
          this.adapter.save(blobKey, blobCopy),
        ])
      }

      // Emit event after save
      if (this.listeners["fragment-saved"]?.length) {
        this.emit("fragment-saved", sedimentreeId, digest, blobCopy)
      }
    } finally {
      this.decrementPending()
    }
  }

  async loadFragment(
    sedimentreeId: SedimentreeId,
    digest: Digest
  ): Promise<FragmentWithBlob | null> {
    const digestHex = digest.toHexString()
    const sid = sedimentreeId.toString()
    const fragmentKey = [PREFIX, FRAGMENTS_PREFIX, sid, digestHex]
    const blobKey = [PREFIX, FRAGMENT_BLOBS_PREFIX, sid, digestHex]

    const [fragmentData, blobData] = await Promise.all([
      this.adapter.load(fragmentKey),
      this.adapter.load(blobKey),
    ])

    if (!fragmentData || !blobData) return null

    const signedFragment = SignedFragment.tryDecode(fragmentData)
    return new FragmentWithBlob(signedFragment, blobData)
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
  ): Promise<FragmentWithBlob[]> {
    const sid = sedimentreeId.toString()
    // Batch: two loadRange calls in parallel instead of 1 + 2M sequential loads.
    const [fragmentChunks, blobChunks] = await Promise.all([
      this.adapter.loadRange([PREFIX, FRAGMENTS_PREFIX, sid]),
      this.adapter.loadRange([PREFIX, FRAGMENT_BLOBS_PREFIX, sid]),
    ])

    // Index blobs by digest hex for O(1) lookup
    const blobsByDigest = new Map<string, Uint8Array>()
    for (const chunk of blobChunks) {
      if (chunk.key.length === 4 && chunk.data) {
        blobsByDigest.set(chunk.key[3], chunk.data)
      }
    }

    const results: FragmentWithBlob[] = []
    for (const chunk of fragmentChunks) {
      if (chunk.key.length !== 4 || !chunk.data) continue
      const digestHex = chunk.key[3]
      const blobData = blobsByDigest.get(digestHex)
      if (!blobData) continue

      const signedFragment = SignedFragment.tryDecode(chunk.data)
      results.push(new FragmentWithBlob(signedFragment, blobData))
    }

    return results
  }

  async deleteFragment(
    sedimentreeId: SedimentreeId,
    digest: Digest
  ): Promise<void> {
    const digestHex = digest.toHexString()
    const sid = sedimentreeId.toString()
    const fragmentKey = [PREFIX, FRAGMENTS_PREFIX, sid, digestHex]
    const blobKey = [PREFIX, FRAGMENT_BLOBS_PREFIX, sid, digestHex]

    await Promise.all([
      this.adapter.remove(fragmentKey),
      this.adapter.remove(blobKey),
    ])
  }

  async deleteAllFragments(sedimentreeId: SedimentreeId): Promise<void> {
    const sid = sedimentreeId.toString()
    await Promise.all([
      this.adapter.removeRange([PREFIX, FRAGMENTS_PREFIX, sid]),
      this.adapter.removeRange([PREFIX, FRAGMENT_BLOBS_PREFIX, sid]),
    ])
  }

  // ==================== Batch Operations ====================

  /**
   * Save a batch of commits and fragments in a single IDB transaction.
   *
   * Called from Subduction's Wasm `save_batch` during sync ingestion.
   * Instead of N individual `saveCommit`/`saveFragment` calls (each creating
   * its own IDB readwrite transaction), this collects all key-value pairs
   * and writes them in one `adapter.saveBatch()` call.
   *
   * For 50 commits this reduces ~100 IDB transactions to 1.
   */
  async saveBatchAll(
    sedimentreeId: SedimentreeId,
    commits: Array<{
      digest: Digest
      signedCommit: SignedLooseCommit
      blob: Uint8Array
    }>,
    fragments: Array<{
      digest: Digest
      signedFragment: SignedFragment
      blob: Uint8Array
    }>
  ): Promise<number> {
    const sid = sedimentreeId.toString()
    const entries: Array<[string[], Uint8Array]> = []

    // Sedimentree ID marker
    entries.push([[PREFIX, IDS_PREFIX, sid], ID_MARKER])

    // Collect all commit key-value pairs
    for (const { digest, signedCommit, blob } of commits) {
      const digestHex = digest.toHexString()
      const commitBytes = signedCommit.encode()
      // Copy from Wasm memory before any async work
      const commitCopy = new Uint8Array(commitBytes)
      const blobCopy = new Uint8Array(blob)

      entries.push([[PREFIX, COMMITS_PREFIX, sid, digestHex], commitCopy])
      entries.push([[PREFIX, BLOBS_PREFIX, sid, digestHex], blobCopy])
    }

    // Collect all fragment key-value pairs
    for (const { digest, signedFragment, blob } of fragments) {
      const digestHex = digest.toHexString()
      const fragBytes = signedFragment.encode()
      const fragCopy = new Uint8Array(fragBytes)
      const blobCopy = new Uint8Array(blob)

      entries.push([[PREFIX, FRAGMENTS_PREFIX, sid, digestHex], fragCopy])
      entries.push([[PREFIX, FRAGMENT_BLOBS_PREFIX, sid, digestHex], blobCopy])
    }

    // Single IDB transaction for all entries
    this.pendingSaves++
    try {
      if (this.adapter.saveBatch) {
        await this.adapter.saveBatch(entries)
      } else {
        // Fallback: parallel individual saves (still better than sequential)
        await Promise.all(
          entries.map(([key, data]) => this.adapter.save(key, data))
        )
      }

      // Emit events after successful save
      for (const { digest, blob } of commits) {
        if (this.listeners["commit-saved"]?.length) {
          this.emit("commit-saved", sedimentreeId, digest, new Uint8Array(blob))
        }
      }
      for (const { digest, blob } of fragments) {
        if (this.listeners["fragment-saved"]?.length) {
          this.emit(
            "fragment-saved",
            sedimentreeId,
            digest,
            new Uint8Array(blob)
          )
        }
      }
    } finally {
      this.decrementPending()
    }

    return commits.length + fragments.length
  }
}

const PREFIX = "subduction"
const IDS_PREFIX = "ids"
const COMMITS_PREFIX = "commits"
const FRAGMENTS_PREFIX = "fragments"
const BLOBS_PREFIX = "blobs"
const FRAGMENT_BLOBS_PREFIX = "fragment-blobs"

/** Marker value for sedimentree ID existence */
const ID_MARKER = new Uint8Array([1])

/**
 * Convert a hex string to Uint8Array.
 */
const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  )
