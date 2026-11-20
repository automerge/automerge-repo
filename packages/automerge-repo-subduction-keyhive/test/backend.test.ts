import { Repo } from "@automerge/automerge-repo"
import * as N from "@automerge/subduction"
import { expect, it, vi } from "vitest"
import { innerBackend } from "../src/KeyhiveBackend.js"
import { createPeer } from "./helpers.js"

it("rejects a signer whose key is not the keyhive's", async () => {
  await expect(
    createPeer(undefined, undefined, { signer: N.createMemorySigner() })
  ).rejects.toThrow(/same key/)
})

it("rejects a sync interval that is not positive", async () => {
  await expect(
    createPeer(undefined, undefined, { syncIntervalMs: 0 })
  ).rejects.toThrow(RangeError)
})

it("rejects a relay key that is not 32 bytes", async () => {
  const { backend } = await createPeer()
  expect(() => backend.addRelay(new Uint8Array(31))).toThrow(/32 bytes/)
})

it("passes a burst of stores to Subduction in a few batches", async () => {
  const peer = await createPeer()
  const repo = new Repo({ backend: peer.backend })
  const handle = await repo.create<{ n: number }>({ n: 0 })
  await repo.flush()
  const store = vi.spyOn(innerBackend(peer.backend), "store")
  const edits = 100
  for (let i = 0; i < edits; i++) handle.change(doc => void (doc.n = i))
  await repo.flush()
  const stored = store.mock.calls.flatMap(([, records]) => [...records])
  expect(stored.length).toBeGreaterThanOrEqual(edits)
  expect(store.mock.calls.length).toBeLessThan(edits / 10)
  await repo.shutdown()
})
