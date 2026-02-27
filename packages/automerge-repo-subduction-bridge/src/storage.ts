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
import type {
  SedimentreeStorage,
  SedimentreeId as SedimentreeIdType,
  Digest as DigestType,
  SignedLooseCommit as SignedLooseCommitType,
  SignedFragment as SignedFragmentType,
  CommitWithBlob as CommitWithBlobType,
  FragmentWithBlob as FragmentWithBlobType,
} from "@automerge/automerge-subduction"

// Lazy-load constructors via the module registered by setSubductionModule()
let _subductionModule: typeof import("@automerge/automerge-subduction") | null =
  null

/**
 * Set the subduction module reference for the storage bridge.
 * This is called automatically by setSubductionModule() from automerge-repo.
 */
export function _setSubductionModuleForStorage(
  module: typeof import("@automerge/automerge-subduction")
): void {
  _subductionModule = module
}

function getSubductionModule(): typeof import("@automerge/automerge-subduction") {
  if (_subductionModule === null) {
    throw new Error(
      "Subduction module not set. Call setSubductionModule() after Wasm initialization."
    )
  }
  return _subductionModule
}

export interface StorageBridgeEvents {
  /**
   * Emitted when a commit is saved.
   * The blob is the Automerge change data.
   */
  "commit-saved": (
    sedimentreeId: SedimentreeIdType,
    digest: DigestType,
    blob: Uint8Array
  ) => void

  /**
   * Emitted when a fragment is saved.
   * The blob is the Automerge bundle data.
   */
  "fragment-saved": (
    sedimentreeId: SedimentreeIdType,
    digest: DigestType,
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

  async saveSedimentreeId(sedimentreeId: SedimentreeIdType): Promise<void> {
    const key = [PREFIX, IDS_PREFIX, sedimentreeId.toString()]
    await this.adapter.save(key, ID_MARKER)
  }

  async deleteSedimentreeId(sedimentreeId: SedimentreeIdType): Promise<void> {
    const key = [PREFIX, IDS_PREFIX, sedimentreeId.toString()]
    await this.adapter.remove(key)
  }

  async loadAllSedimentreeIds(): Promise<SedimentreeIdType[]> {
    const SedimentreeId = getSubductionModule().SedimentreeId
    const chunks = await this.adapter.loadRange([PREFIX, IDS_PREFIX])
    return chunks
      .filter(chunk => chunk.key.length === 3 && chunk.data)
      .map(chunk => SedimentreeId.fromBytes(hexToBytes(chunk.key[2])))
  }

  // ==================== Commits (compound storage with blob) ====================

  async saveCommit(
    sedimentreeId: SedimentreeIdType,
    digest: DigestType,
    signedCommit: SignedLooseCommitType,
    blob: Uint8Array
  ): Promise<void> {
    // Encode the signed commit to bytes
    const commitBytes = signedCommit.encode()
    // Copy bytes from WASM memory view BEFORE any async operations
    const commitCopy = new Uint8Array(commitBytes)
    const blobCopy = new Uint8Array(blob)

    this.pendingSaves++
    try {
      const digestHex = bytesToHex(digest.toBytes())
      const commitKey = [
        PREFIX,
        COMMITS_PREFIX,
        sedimentreeId.toString(),
        digestHex,
      ]
      const blobKey = [
        PREFIX,
        BLOBS_PREFIX,
        sedimentreeId.toString(),
        digestHex,
      ]

      await Promise.all([
        this.adapter.save(commitKey, commitCopy),
        this.adapter.save(blobKey, blobCopy),
      ])

      // Emit event after save
      if (this.listeners["commit-saved"]?.length) {
        this.emit("commit-saved", sedimentreeId, digest, blobCopy)
      }
    } finally {
      this.decrementPending()
    }
  }

  async loadCommit(
    sedimentreeId: SedimentreeIdType,
    digest: DigestType
  ): Promise<CommitWithBlobType | null> {
    const { SignedLooseCommit, CommitWithBlob } = getSubductionModule()
    const digestHex = bytesToHex(digest.toBytes())
    const commitKey = [
      PREFIX,
      COMMITS_PREFIX,
      sedimentreeId.toString(),
      digestHex,
    ]
    const blobKey = [PREFIX, BLOBS_PREFIX, sedimentreeId.toString(), digestHex]

    const [commitData, blobData] = await Promise.all([
      this.adapter.load(commitKey),
      this.adapter.load(blobKey),
    ])

    if (!commitData || !blobData) return null

    const signedCommit = SignedLooseCommit.tryDecode(commitData)
    return new CommitWithBlob(signedCommit, blobData)
  }

  async listCommitDigests(
    sedimentreeId: SedimentreeIdType
  ): Promise<DigestType[]> {
    const Digest = getSubductionModule().Digest
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
    sedimentreeId: SedimentreeIdType
  ): Promise<CommitWithBlobType[]> {
    const digests = await this.listCommitDigests(sedimentreeId)
    const results: CommitWithBlobType[] = []

    for (const digest of digests) {
      const commitWithBlob = await this.loadCommit(sedimentreeId, digest)
      if (commitWithBlob) {
        results.push(commitWithBlob)
      }
    }

    return results
  }

  async deleteCommit(
    sedimentreeId: SedimentreeIdType,
    digest: DigestType
  ): Promise<void> {
    const digestHex = bytesToHex(digest.toBytes())
    const commitKey = [
      PREFIX,
      COMMITS_PREFIX,
      sedimentreeId.toString(),
      digestHex,
    ]
    const blobKey = [PREFIX, BLOBS_PREFIX, sedimentreeId.toString(), digestHex]

    await Promise.all([
      this.adapter.remove(commitKey),
      this.adapter.remove(blobKey),
    ])
  }

  async deleteAllCommits(sedimentreeId: SedimentreeIdType): Promise<void> {
    await Promise.all([
      this.adapter.removeRange([
        PREFIX,
        COMMITS_PREFIX,
        sedimentreeId.toString(),
      ]),
      // Also clean up blobs for commits
      this.adapter.removeRange([
        PREFIX,
        BLOBS_PREFIX,
        sedimentreeId.toString(),
      ]),
    ])
  }

  // ==================== Fragments (compound storage with blob) ====================

  async saveFragment(
    sedimentreeId: SedimentreeIdType,
    digest: DigestType,
    signedFragment: SignedFragmentType,
    blob: Uint8Array
  ): Promise<void> {
    // Encode the signed fragment to bytes
    const fragmentBytes = signedFragment.encode()
    // Copy bytes from WASM memory view BEFORE any async operations
    const fragmentCopy = new Uint8Array(fragmentBytes)
    const blobCopy = new Uint8Array(blob)

    this.pendingSaves++
    try {
      const digestHex = bytesToHex(digest.toBytes())
      const fragmentKey = [
        PREFIX,
        FRAGMENTS_PREFIX,
        sedimentreeId.toString(),
        digestHex,
      ]
      const blobKey = [
        PREFIX,
        FRAGMENT_BLOBS_PREFIX,
        sedimentreeId.toString(),
        digestHex,
      ]

      await Promise.all([
        this.adapter.save(fragmentKey, fragmentCopy),
        this.adapter.save(blobKey, blobCopy),
      ])

      // Emit event after save
      if (this.listeners["fragment-saved"]?.length) {
        this.emit("fragment-saved", sedimentreeId, digest, blobCopy)
      }
    } finally {
      this.decrementPending()
    }
  }

  async loadFragment(
    sedimentreeId: SedimentreeIdType,
    digest: DigestType
  ): Promise<FragmentWithBlobType | null> {
    const { SignedFragment, FragmentWithBlob } = getSubductionModule()
    const digestHex = bytesToHex(digest.toBytes())
    const fragmentKey = [
      PREFIX,
      FRAGMENTS_PREFIX,
      sedimentreeId.toString(),
      digestHex,
    ]
    const blobKey = [
      PREFIX,
      FRAGMENT_BLOBS_PREFIX,
      sedimentreeId.toString(),
      digestHex,
    ]

    const [fragmentData, blobData] = await Promise.all([
      this.adapter.load(fragmentKey),
      this.adapter.load(blobKey),
    ])

    if (!fragmentData || !blobData) return null

    const signedFragment = SignedFragment.tryDecode(fragmentData)
    return new FragmentWithBlob(signedFragment, blobData)
  }

  async listFragmentDigests(
    sedimentreeId: SedimentreeIdType
  ): Promise<DigestType[]> {
    const Digest = getSubductionModule().Digest
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
    sedimentreeId: SedimentreeIdType
  ): Promise<FragmentWithBlobType[]> {
    const digests = await this.listFragmentDigests(sedimentreeId)
    const results: FragmentWithBlobType[] = []

    for (const digest of digests) {
      const fragmentWithBlob = await this.loadFragment(sedimentreeId, digest)
      if (fragmentWithBlob) {
        results.push(fragmentWithBlob)
      }
    }

    return results
  }

  async deleteFragment(
    sedimentreeId: SedimentreeIdType,
    digest: DigestType
  ): Promise<void> {
    const digestHex = bytesToHex(digest.toBytes())
    const fragmentKey = [
      PREFIX,
      FRAGMENTS_PREFIX,
      sedimentreeId.toString(),
      digestHex,
    ]
    const blobKey = [
      PREFIX,
      FRAGMENT_BLOBS_PREFIX,
      sedimentreeId.toString(),
      digestHex,
    ]

    await Promise.all([
      this.adapter.remove(fragmentKey),
      this.adapter.remove(blobKey),
    ])
  }

  async deleteAllFragments(sedimentreeId: SedimentreeIdType): Promise<void> {
    await Promise.all([
      this.adapter.removeRange([
        PREFIX,
        FRAGMENTS_PREFIX,
        sedimentreeId.toString(),
      ]),
      this.adapter.removeRange([
        PREFIX,
        FRAGMENT_BLOBS_PREFIX,
        sedimentreeId.toString(),
      ]),
    ])
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

/**
 * Convert Uint8Array to hex string.
 */
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
