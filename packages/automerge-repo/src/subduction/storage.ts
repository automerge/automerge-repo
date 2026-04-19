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
  CommitId,
  CommitWithBlob,
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
    commitId: CommitId,
    blob: Uint8Array
  ) => void

  /**
   * Emitted when a fragment is saved.
   * The blob is the Automerge bundle data.
   */
  "fragment-saved": (
    sedimentreeId: SedimentreeId,
    commitId: CommitId,
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
 * Supports event callbacks via `on()` for commit-saved and fragment-saved events.
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
    commitId: CommitId,
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
      const idHex = commitId.toHexString()
      const sid = sedimentreeId.toString()
      const commitKey = [PREFIX, COMMITS_PREFIX, sid, idHex]
      const blobKey = [PREFIX, BLOBS_PREFIX, sid, idHex]

      // Write blob first, then commit metadata. Any crash between the
      // two yields an orphan blob (harmless, skipped by the reader)
      // rather than a commit pointing at a missing blob.
      //
      // We deliberately don't use adapter.saveBatch here even when
      // available: saveBatch's contract guarantees each entry lands
      // atomically, but an implementation that executes entries in
      // parallel (e.g. NodeFS) could still produce commit-without-blob
      // on crash. Two sequential save() calls cost one extra `await`
      // boundary and are unambiguously crash-consistent.
      await this.adapter.save(blobKey, blobCopy)
      await this.adapter.save(commitKey, commitCopy)

      // Emit event after save
      if (this.listeners["commit-saved"]?.length) {
        this.emit("commit-saved", sedimentreeId, commitId, blobCopy)
      }
    } finally {
      this.decrementPending()
    }
  }

  async loadCommit(
    sedimentreeId: SedimentreeId,
    commitId: CommitId
  ): Promise<CommitWithBlob | null> {
    const idHex = commitId.toHexString()
    const sid = sedimentreeId.toString()
    const commitKey = [PREFIX, COMMITS_PREFIX, sid, idHex]
    const blobKey = [PREFIX, BLOBS_PREFIX, sid, idHex]

    const [commitData, blobData] = await Promise.all([
      this.adapter.load(commitKey),
      this.adapter.load(blobKey),
    ])

    if (!commitData || !blobData) return null

    const signedCommit = SignedLooseCommit.tryDecode(commitData)
    return new CommitWithBlob(signedCommit, blobData)
  }

  async listCommitIds(sedimentreeId: SedimentreeId): Promise<CommitId[]> {
    const chunks = await this.adapter.loadRange([
      PREFIX,
      COMMITS_PREFIX,
      sedimentreeId.toString(),
    ])
    return chunks
      .filter(chunk => chunk.key.length === 4 && chunk.data)
      .map(chunk => CommitId.fromBytes(hexToBytes(chunk.key[3])))
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

    // Index blobs by id hex for O(1) lookup
    const blobsById = new Map<string, Uint8Array>()
    for (const chunk of blobChunks) {
      if (chunk.key.length === 4 && chunk.data) {
        blobsById.set(chunk.key[3], chunk.data)
      }
    }

    const results: CommitWithBlob[] = []
    for (const chunk of commitChunks) {
      if (chunk.key.length !== 4 || !chunk.data) continue
      const idHex = chunk.key[3]
      const blobData = blobsById.get(idHex)
      if (!blobData) continue

      const signedCommit = SignedLooseCommit.tryDecode(chunk.data)
      results.push(new CommitWithBlob(signedCommit, blobData))
    }

    return results
  }

  async deleteCommit(
    sedimentreeId: SedimentreeId,
    commitId: CommitId
  ): Promise<void> {
    const idHex = commitId.toHexString()
    const sid = sedimentreeId.toString()
    const commitKey = [PREFIX, COMMITS_PREFIX, sid, idHex]
    const blobKey = [PREFIX, BLOBS_PREFIX, sid, idHex]

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
    fragmentHead: CommitId,
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
      const idHex = fragmentHead.toHexString()
      const sid = sedimentreeId.toString()
      const fragmentKey = [PREFIX, FRAGMENTS_PREFIX, sid, idHex]
      const blobKey = [PREFIX, FRAGMENT_BLOBS_PREFIX, sid, idHex]

      // Write blob first, then fragment metadata. Any crash between
      // the two yields an orphan blob (harmless) rather than a
      // fragment pointing at missing data.
      //
      // We deliberately don't use adapter.saveBatch here; see the
      // matching comment in saveCommit for rationale.
      await this.adapter.save(blobKey, blobCopy)
      await this.adapter.save(fragmentKey, fragmentCopy)

      // Emit event after save
      if (this.listeners["fragment-saved"]?.length) {
        this.emit("fragment-saved", sedimentreeId, fragmentHead, blobCopy)
      }
    } finally {
      this.decrementPending()
    }
  }

  async loadFragment(
    sedimentreeId: SedimentreeId,
    fragmentHead: CommitId
  ): Promise<FragmentWithBlob | null> {
    const idHex = fragmentHead.toHexString()
    const sid = sedimentreeId.toString()
    const fragmentKey = [PREFIX, FRAGMENTS_PREFIX, sid, idHex]
    const blobKey = [PREFIX, FRAGMENT_BLOBS_PREFIX, sid, idHex]

    const [fragmentData, blobData] = await Promise.all([
      this.adapter.load(fragmentKey),
      this.adapter.load(blobKey),
    ])

    if (!fragmentData || !blobData) return null

    const signedFragment = SignedFragment.tryDecode(fragmentData)
    return new FragmentWithBlob(signedFragment, blobData)
  }

  async listFragmentIds(sedimentreeId: SedimentreeId): Promise<CommitId[]> {
    const chunks = await this.adapter.loadRange([
      PREFIX,
      FRAGMENTS_PREFIX,
      sedimentreeId.toString(),
    ])
    return chunks
      .filter(chunk => chunk.key.length === 4 && chunk.data)
      .map(chunk => CommitId.fromBytes(hexToBytes(chunk.key[3])))
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

    // Index blobs by id hex for O(1) lookup
    const blobsById = new Map<string, Uint8Array>()
    for (const chunk of blobChunks) {
      if (chunk.key.length === 4 && chunk.data) {
        blobsById.set(chunk.key[3], chunk.data)
      }
    }

    const results: FragmentWithBlob[] = []
    for (const chunk of fragmentChunks) {
      if (chunk.key.length !== 4 || !chunk.data) continue
      const idHex = chunk.key[3]
      const blobData = blobsById.get(idHex)
      if (!blobData) continue

      const signedFragment = SignedFragment.tryDecode(chunk.data)
      results.push(new FragmentWithBlob(signedFragment, blobData))
    }

    return results
  }

  async deleteFragment(
    sedimentreeId: SedimentreeId,
    fragmentHead: CommitId
  ): Promise<void> {
    const idHex = fragmentHead.toHexString()
    const sid = sedimentreeId.toString()
    const fragmentKey = [PREFIX, FRAGMENTS_PREFIX, sid, idHex]
    const blobKey = [PREFIX, FRAGMENT_BLOBS_PREFIX, sid, idHex]

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
   * Save a batch of commits and fragments.
   *
   * Called from Subduction's Wasm `save_batch` during sync ingestion.
   * Instead of N individual `saveCommit`/`saveFragment` calls (each
   * creating its own underlying transaction), this issues at most three
   * `adapter.saveBatch()` calls (blobs, metadata, sedimentree ID marker)
   * in order.
   *
   * The three-phase structure enforces write-ahead ordering so that any
   * crash-prefix state is consistent: orphan blobs (harmless), or blobs
   * + metadata without the ID marker (invisible to enumeration).
   *
   * For 50 commits this reduces ~100 round-trips to 3 on adapters that
   * implement `adapter.saveBatch`.
   */
  async saveBatchAll(
    sedimentreeId: SedimentreeId,
    commits: Array<{
      commitId: CommitId
      signedCommit: SignedLooseCommit
      blob: Uint8Array
    }>,
    fragments: Array<{
      fragmentHead: CommitId
      signedFragment: SignedFragment
      blob: Uint8Array
    }>
  ): Promise<number> {
    const sid = sedimentreeId.toString()

    // Write-ahead ordering: collect entries in three groups that must
    // be written in order so any crash-prefix state is consistent.
    //
    //   1. All blobs (commit blobs and fragment blobs). Orphan blobs
    //      without their metadata are skipped silently by loadAll* and
    //      are harmless on-disk garbage.
    //   2. All metadata (signed commits and signed fragments). By the
    //      time any of this is visible, every blob it references is
    //      already durable.
    //   3. The sedimentree ID marker. This makes the sedimentree
    //      enumerable via loadAllSedimentreeIds only once its data is
    //      durable; a crash before this point leaves invisible-but-
    //      otherwise-consistent state that the next run will ignore.
    //
    // We enforce the ordering at the `await` boundary between phases
    // rather than relying on in-batch entry order. An `adapter.saveBatch`
    // call may internally parallelise entries (e.g. NodeFS), so stuffing
    // all three phases into one saveBatch call doesn't preserve the
    // invariant on crash. Three sequential saveBatch calls preserve the
    // invariant for any adapter whose single saveBatch is "atomic per
    // entry and durable before returning" — a much weaker contract than
    // full cross-entry transactionality, which IDB happens to satisfy
    // but NodeFS does not.
    const blobEntries: Array<[string[], Uint8Array]> = []
    const metaEntries: Array<[string[], Uint8Array]> = []

    // Retain copies of each blob so we can emit them after the save.
    const commitBlobCopies: Uint8Array[] = []
    const fragmentBlobCopies: Uint8Array[] = []

    for (const { commitId, signedCommit, blob } of commits) {
      const idHex = commitId.toHexString()
      const commitBytes = signedCommit.encode()
      // Copy from Wasm memory before any async work
      const commitCopy = new Uint8Array(commitBytes)
      const blobCopy = new Uint8Array(blob)

      blobEntries.push([[PREFIX, BLOBS_PREFIX, sid, idHex], blobCopy])
      metaEntries.push([[PREFIX, COMMITS_PREFIX, sid, idHex], commitCopy])
      commitBlobCopies.push(blobCopy)
    }

    for (const { fragmentHead, signedFragment, blob } of fragments) {
      const idHex = fragmentHead.toHexString()
      const fragBytes = signedFragment.encode()
      const fragCopy = new Uint8Array(fragBytes)
      const blobCopy = new Uint8Array(blob)

      blobEntries.push([[PREFIX, FRAGMENT_BLOBS_PREFIX, sid, idHex], blobCopy])
      metaEntries.push([[PREFIX, FRAGMENTS_PREFIX, sid, idHex], fragCopy])
      fragmentBlobCopies.push(blobCopy)
    }

    const markerEntry: [string[], Uint8Array] = [
      [PREFIX, IDS_PREFIX, sid],
      ID_MARKER,
    ]

    this.pendingSaves++
    try {
      if (this.adapter.saveBatch) {
        // Three sequential saveBatch calls. Each phase is parallelised
        // inside the adapter (fast); the `await` boundary between phases
        // enforces the write-ahead ordering (correct under crash).
        if (blobEntries.length > 0) {
          await this.adapter.saveBatch(blobEntries)
        }
        if (metaEntries.length > 0) {
          await this.adapter.saveBatch(metaEntries)
        }
        await this.adapter.saveBatch([markerEntry])
      } else {
        // Fallback: three sequential phases, parallel within each phase.
        // A crash between phases leaves a consistent prefix (orphan
        // blobs, or blobs+metadata without marker).
        await Promise.all(
          blobEntries.map(([key, data]) => this.adapter.save(key, data))
        )
        await Promise.all(
          metaEntries.map(([key, data]) => this.adapter.save(key, data))
        )
        await this.adapter.save(markerEntry[0], markerEntry[1])
      }

      if (this.listeners["commit-saved"]?.length) {
        commits.forEach(({ commitId }, i) => {
          this.emit(
            "commit-saved",
            sedimentreeId,
            commitId,
            commitBlobCopies[i]
          )
        })
      }
      if (this.listeners["fragment-saved"]?.length) {
        fragments.forEach(({ fragmentHead }, i) => {
          this.emit(
            "fragment-saved",
            sedimentreeId,
            fragmentHead,
            fragmentBlobCopies[i]
          )
        })
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
