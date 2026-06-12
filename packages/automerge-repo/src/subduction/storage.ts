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
 * const subduction = new Subduction({ signer, storage })
 * ```
 */

import type { StorageAdapterInterface } from "../storage/StorageAdapterInterface.js"
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
/**
 * A pending settle waiter. If `sids` is `undefined`, the waiter cares
 * about all in-flight saves. Otherwise it cares only about saves whose
 * sedimentree id is in `sids`.
 *
 * `remaining` counts how many tracked pending saves the waiter is still
 * blocked on. When it reaches 0, `resolve()` is called and the entry is
 * dropped from the resolver list.
 */
interface SettleWaiter {
  sids: Set<string> | undefined
  remaining: number
  resolve: () => void
}

export class SubductionStorageBridge implements SedimentreeStorage {
  private adapter: StorageAdapterInterface
  /**
   * First storage-key segment for every subduction key this bridge
   * writes and reads. Defaults to {@link DEFAULT_PREFIX}. An
   * interceptor-backed store uses {@link INTERCEPTOR_PREFIX} so its
   * keys never collide with an untransformed store sharing one adapter.
   */
  private readonly prefix: string
  private listeners: {
    [K in keyof StorageBridgeEvents]?: StorageBridgeEvents[K][]
  } = {}

  /** Per-sedimentree pending-save counts. Absent ⇒ 0. */
  private pendingPerSid: Map<string, number> = new Map()
  private settleWaiters: SettleWaiter[] = []

  constructor(
    adapter: StorageAdapterInterface,
    prefix: string = DEFAULT_PREFIX
  ) {
    this.prefix = prefix
    this.adapter = adapter
  }

  /**
   * Wait for in-scope save operations to drain.
   *
   * Counter-based: the waiter snapshots how many saves are pending
   * for the targeted scope at call time and resolves once that many
   * matching saves complete. Saves that start after registration
   * count toward the same total — fine for `flush()`-style callers
   * that have already pumped their throttles, but means a new save
   * completing before an older one can resolve the waiter while the
   * older save is still pending. Don't add call patterns that race
   * here.
   *
   * `sids === undefined` waits on every in-flight save; otherwise
   * waits on saves whose sedimentree id is in `sids`. Resolves
   * immediately when the matching scope is empty.
   */
  async awaitSettled(sids?: Iterable<string>): Promise<void> {
    if (sids === undefined) {
      const total = this.totalPending()
      if (total === 0) return
      return new Promise(resolve =>
        this.settleWaiters.push({
          sids: undefined,
          remaining: total,
          resolve,
        })
      )
    }

    const sidSet = sids instanceof Set ? sids : new Set(sids)
    let remaining = 0
    for (const sid of sidSet) {
      remaining += this.pendingPerSid.get(sid) ?? 0
    }
    if (remaining === 0) return

    return new Promise(resolve =>
      this.settleWaiters.push({ sids: sidSet, remaining, resolve })
    )
  }

  private totalPending(): number {
    let total = 0
    for (const n of this.pendingPerSid.values()) total += n
    return total
  }

  private incrementPending(sid: string): void {
    this.pendingPerSid.set(sid, (this.pendingPerSid.get(sid) ?? 0) + 1)
  }

  private decrementPending(sid: string): void {
    const n = this.pendingPerSid.get(sid) ?? 0
    if (n <= 1) {
      this.pendingPerSid.delete(sid)
    } else {
      this.pendingPerSid.set(sid, n - 1)
    }

    if (this.settleWaiters.length === 0) return

    // Decrement counters for any waiter that cares about this sid.
    // Resolve and drop those that reach 0.
    const stillWaiting: SettleWaiter[] = []
    for (const w of this.settleWaiters) {
      if (w.sids === undefined || w.sids.has(sid)) {
        w.remaining--
        if (w.remaining <= 0) {
          w.resolve()
          continue
        }
      }
      stillWaiting.push(w)
    }
    this.settleWaiters = stillWaiting
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
    const key = [this.prefix, IDS_PREFIX, sedimentreeId.toString()]
    await this.adapter.save(key, ID_MARKER)
  }

  async deleteSedimentreeId(sedimentreeId: SedimentreeId): Promise<void> {
    const key = [this.prefix, IDS_PREFIX, sedimentreeId.toString()]
    await this.adapter.remove(key)
  }

  async loadAllSedimentreeIds(): Promise<SedimentreeId[]> {
    const chunks = await this.adapter.loadRange([this.prefix, IDS_PREFIX])
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

    const sid = sedimentreeId.toString()
    this.incrementPending(sid)
    try {
      const idHex = commitId.toHexString()
      const commitKey = [this.prefix, COMMITS_PREFIX, sid, idHex]
      const blobKey = [this.prefix, BLOBS_PREFIX, sid, idHex]

      await this.adapter.saveBatch([
        [blobKey, blobCopy],
        [commitKey, commitCopy],
      ])

      // Emit a fresh copy per event. `blobCopy` is already the bytes
      // we handed to the adapter, and adapters (e.g. NodeFS) cache by
      // reference. A listener that mutates the shared reference would
      // corrupt the adapter's cache and affect other listeners.
      if (this.listeners["commit-saved"]?.length) {
        this.emit(
          "commit-saved",
          sedimentreeId,
          commitId,
          new Uint8Array(blobCopy)
        )
      }
    } finally {
      this.decrementPending(sid)
    }
  }

  async loadCommit(
    sedimentreeId: SedimentreeId,
    commitId: CommitId
  ): Promise<CommitWithBlob | null> {
    const idHex = commitId.toHexString()
    const sid = sedimentreeId.toString()
    const commitKey = [this.prefix, COMMITS_PREFIX, sid, idHex]
    const blobKey = [this.prefix, BLOBS_PREFIX, sid, idHex]

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
      this.prefix,
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
      this.adapter.loadRange([this.prefix, COMMITS_PREFIX, sid]),
      this.adapter.loadRange([this.prefix, BLOBS_PREFIX, sid]),
    ])

    // Index blobs by id hex for O(1) lookup.
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
    const commitKey = [this.prefix, COMMITS_PREFIX, sid, idHex]
    const blobKey = [this.prefix, BLOBS_PREFIX, sid, idHex]

    await Promise.all([
      this.adapter.remove(commitKey),
      this.adapter.remove(blobKey),
    ])
  }

  async deleteAllCommits(sedimentreeId: SedimentreeId): Promise<void> {
    const sid = sedimentreeId.toString()
    await Promise.all([
      this.adapter.removeRange([this.prefix, COMMITS_PREFIX, sid]),
      this.adapter.removeRange([this.prefix, BLOBS_PREFIX, sid]),
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

    const sid = sedimentreeId.toString()
    this.incrementPending(sid)
    try {
      const idHex = fragmentHead.toHexString()
      const fragmentKey = [this.prefix, FRAGMENTS_PREFIX, sid, idHex]
      const blobKey = [this.prefix, FRAGMENT_BLOBS_PREFIX, sid, idHex]

      // See the matching comment in saveCommit for rationale.
      await this.adapter.saveBatch([
        [blobKey, blobCopy],
        [fragmentKey, fragmentCopy],
      ])

      // Defensive copy per event; see comment in saveCommit.
      if (this.listeners["fragment-saved"]?.length) {
        this.emit(
          "fragment-saved",
          sedimentreeId,
          fragmentHead,
          new Uint8Array(blobCopy)
        )
      }
    } finally {
      this.decrementPending(sid)
    }
  }

  async loadFragment(
    sedimentreeId: SedimentreeId,
    fragmentHead: CommitId
  ): Promise<FragmentWithBlob | null> {
    const idHex = fragmentHead.toHexString()
    const sid = sedimentreeId.toString()
    const fragmentKey = [this.prefix, FRAGMENTS_PREFIX, sid, idHex]
    const blobKey = [this.prefix, FRAGMENT_BLOBS_PREFIX, sid, idHex]

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
      this.prefix,
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
      this.adapter.loadRange([this.prefix, FRAGMENTS_PREFIX, sid]),
      this.adapter.loadRange([this.prefix, FRAGMENT_BLOBS_PREFIX, sid]),
    ])

    // Index blobs by id hex for O(1) lookup.
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
    const fragmentKey = [this.prefix, FRAGMENTS_PREFIX, sid, idHex]
    const blobKey = [this.prefix, FRAGMENT_BLOBS_PREFIX, sid, idHex]

    await Promise.all([
      this.adapter.remove(fragmentKey),
      this.adapter.remove(blobKey),
    ])
  }

  async deleteAllFragments(sedimentreeId: SedimentreeId): Promise<void> {
    const sid = sedimentreeId.toString()
    await Promise.all([
      this.adapter.removeRange([this.prefix, FRAGMENTS_PREFIX, sid]),
      this.adapter.removeRange([this.prefix, FRAGMENT_BLOBS_PREFIX, sid]),
    ])
  }

  // ==================== Batch Operations ====================

  /**
   * Save a batch of commits and fragments.
   *
   * Issues three sequential `adapter.saveBatch()` calls — blobs,
   * then metadata, then the ID marker — to preserve crash-prefix
   * consistency on adapters whose `saveBatch` is per-entry-atomic
   * but not all-or-nothing across the batch (e.g. NodeFS).
   *
   * Crash invariants:
   *   - Crash during/after blobs only:  orphan blobs. Harmless.
   *   - Crash during/after metadata:    blobs + meta, no marker.
   *                                     Invisible to enumeration.
   *   - Crash after marker:             fully visible (only state
   *                                     in which this sedimentree
   *                                     appears in
   *                                     `loadAllSedimentreeIds`).
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

    // Retain copies of each blob so we can emit them after the save.
    const commitBlobCopies: Uint8Array[] = []
    const fragmentBlobCopies: Uint8Array[] = []

    const blobEntries: Array<[string[], Uint8Array]> = []
    const metaEntries: Array<[string[], Uint8Array]> = []

    for (const { commitId, signedCommit, blob } of commits) {
      const idHex = commitId.toHexString()
      const blobCopy = new Uint8Array(blob)
      const commitCopy = new Uint8Array(signedCommit.encode())
      blobEntries.push([[this.prefix, BLOBS_PREFIX, sid, idHex], blobCopy])
      metaEntries.push([[this.prefix, COMMITS_PREFIX, sid, idHex], commitCopy])
      commitBlobCopies.push(blobCopy)
    }
    for (const { fragmentHead, signedFragment, blob } of fragments) {
      const idHex = fragmentHead.toHexString()
      const blobCopy = new Uint8Array(blob)
      const fragCopy = new Uint8Array(signedFragment.encode())
      blobEntries.push([[this.prefix, FRAGMENT_BLOBS_PREFIX, sid, idHex], blobCopy])
      metaEntries.push([[this.prefix, FRAGMENTS_PREFIX, sid, idHex], fragCopy])
      fragmentBlobCopies.push(blobCopy)
    }

    const markerEntry: [string[], Uint8Array] = [
      [this.prefix, IDS_PREFIX, sid],
      ID_MARKER,
    ]

    this.incrementPending(sid)
    try {
      // Three sequential phases for crash-prefix safety; see the
      // class docstring above for the full state-machine analysis.
      if (blobEntries.length > 0) {
        await this.adapter.saveBatch(blobEntries)
      }
      if (metaEntries.length > 0) {
        await this.adapter.saveBatch(metaEntries)
      }
      await this.adapter.saveBatch([markerEntry])

      // Defensive copy per event; see comment in saveCommit.
      if (this.listeners["commit-saved"]?.length) {
        commits.forEach(({ commitId }, i) => {
          this.emit(
            "commit-saved",
            sedimentreeId,
            commitId,
            new Uint8Array(commitBlobCopies[i])
          )
        })
      }
      if (this.listeners["fragment-saved"]?.length) {
        fragments.forEach(({ fragmentHead }, i) => {
          this.emit(
            "fragment-saved",
            sedimentreeId,
            fragmentHead,
            new Uint8Array(fragmentBlobCopies[i])
          )
        })
      }
    } finally {
      this.decrementPending(sid)
    }

    return commits.length + fragments.length
  }
}

/** Default storage-key prefix for a subduction store. */
export const DEFAULT_PREFIX = "subduction"
/**
 * Storage-key prefix for a subduction store whose Repo has a blob
 * interceptor configured. An interceptor transforms the stored
 * representation (e.g., encrypts it), so its commits must not share keys
 * with untransformed commits. Keeping them under a separate prefix
 * prevents a collision when two Repos back their subduction stores with
 * one shared `storage` (e.g., a browser page and its service worker on one
 * origin IndexedDB), where only one Repo runs the interceptor.
 */
export const INTERCEPTOR_PREFIX = "subduction-interceptor"
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
