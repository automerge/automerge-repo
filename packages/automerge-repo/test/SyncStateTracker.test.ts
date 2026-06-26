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
