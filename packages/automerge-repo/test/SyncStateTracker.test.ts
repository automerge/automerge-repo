import { next as A } from "@automerge/automerge"
import assert from "assert"
import { describe, it, vi } from "vitest"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import type { DocHandle } from "../src/DocHandle.js"
import { SyncStateTracker } from "../src/SyncStateTracker.js"
import { StorageSubsystem } from "../src/storage/StorageSubsystem.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import type { StorageId } from "../src/storage/types.js"
import type { SyncStatePayload } from "../src/synchronizer/Synchronizer.js"
import type { PeerId } from "../src/types.js"

describe("SyncStateTracker", () => {
  const peerMetadata = {
    storageId: "storage-1" as StorageId,
    isEphemeral: false,
  }
  const fakeHandle = () =>
    ({ emit: () => true }) as unknown as DocHandle<unknown>
  const newDocumentId = () =>
    parseAutomergeUrl(generateAutomergeUrl()).documentId
  const syncWithPeer = (
    tracker: SyncStateTracker,
    documentId: ReturnType<typeof newDocumentId>,
    handle: DocHandle<unknown>
  ) =>
    tracker.handleSyncState(
      {
        peerId: "peer-1" as PeerId,
        documentId,
        syncState: A.initSyncState(),
      },
      peerMetadata,
      handle
    )

  it("persists the sync state of every document that syncs with a peer in one debounce window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const subsystem = new StorageSubsystem(new DummyStorageAdapter())
      const savedDocs: string[] = []
      vi.spyOn(subsystem, "saveSyncState").mockImplementation(
        async documentId => {
          savedDocs.push(documentId)
        }
      )
      const tracker = new SyncStateTracker(subsystem, 10)

      const docA = newDocumentId()
      const docB = newDocumentId()
      syncWithPeer(tracker, docA, fakeHandle())
      syncWithPeer(tracker, docB, fakeHandle())

      await vi.advanceTimersByTimeAsync(20)
      assert.deepEqual(
        savedDocs.sort(),
        [docA, docB].sort(),
        "both documents' sync states must be persisted"
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("bounds concurrent sync-state writes across documents", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const subsystem = new StorageSubsystem(new DummyStorageAdapter())
      const inFlight: Array<{ documentId: string; resolve: () => void }> = []
      const savedDocs: string[] = []
      vi.spyOn(subsystem, "saveSyncState").mockImplementation(
        async documentId => {
          const { promise, resolve } = Promise.withResolvers<void>()
          inFlight.push({ documentId, resolve })
          await promise
          savedDocs.push(documentId)
        }
      )
      const tracker = new SyncStateTracker(subsystem, 10, 2)

      const docs = Array.from({ length: 5 }, newDocumentId)
      for (const documentId of docs) {
        syncWithPeer(tracker, documentId, fakeHandle())
      }
      await vi.advanceTimersByTimeAsync(20)
      assert.equal(inFlight.length, 2, "only two writes may start at once")

      // Each completed write lets exactly one queued write start.
      for (let started = 2; started < docs.length; started++) {
        inFlight[started - 2].resolve()
        await vi.advanceTimersByTimeAsync(0)
        assert.equal(inFlight.length, started + 1)
      }
      inFlight.slice(-2).forEach(({ resolve }) => resolve())
      await vi.advanceTimersByTimeAsync(0)

      assert.deepEqual(savedDocs.sort(), [...docs].sort())
    } finally {
      vi.useRealTimers()
    }
  })

  it("logs a failed sync-state save instead of leaking an unhandled rejection", async () => {
    // The throttled sync-state save runs fire-and-forget (its promise is
    // discarded). If the storage write rejects, the rejection must be caught
    // and logged, not left to surface as an unhandled rejection (which exits a
    // Node sync server by default). Mirrors StorageSource's save path.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      // An adapter whose save() always rejects (disk/IO error, quota, ...).
      const adapter = new DummyStorageAdapter()
      adapter.save = async () => {
        throw new Error("simulated storage write failure")
      }

      const tracker = new SyncStateTracker(new StorageSubsystem(adapter), 10)

      // handleSyncState only touches `handle` to emit "remote-heads" after the
      // save is scheduled, so a minimal stub is enough to exercise the save path.
      const handle = { emit: () => true } as unknown as DocHandle<unknown>
      const message: SyncStatePayload = {
        peerId: "peer-1" as PeerId,
        documentId: parseAutomergeUrl(generateAutomergeUrl()).documentId,
        syncState: A.initSyncState(),
      }
      const peerMetadata = {
        storageId: "storage-1" as StorageId,
        isEphemeral: false,
      }

      tracker.handleSyncState(message, peerMetadata, handle)

      // The failure must be caught and logged, not floated as a rejection.
      await vi.waitFor(() =>
        assert.ok(
          errSpy.mock.calls.some(call =>
            call.some(arg => String(arg).includes("Error saving sync state"))
          ),
          "the failed sync-state save should be caught and logged"
        )
      )
    } finally {
      errSpy.mockRestore()
    }
  })
})
