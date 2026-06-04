/**
 * Regression test for the per-doc `addBatch` broadcast antipattern.
 *
 * SubductionSource now uses `addCommitsBatch` (no trailing broadcast)
 * instead of `addBatch`. This test verifies:
 *   1. `addBatch` is never called (broadcast eliminated).
 *   2. `addCommitsBatch` IS called for every doc (correct save path).
 *   3. Per-call `addCommitsBatch` latency stays bounded as the host
 *      accumulates sedimentrees (O(1) storage write vs old O(N) broadcast).
 *
 * If this test fails, do NOT relax the threshold — the assertions are
 * structural. A failure means SubductionSource reverted to `addBatch`
 * or the save path was changed to something with per-call O(N) cost.
 */

import { beforeAll, describe, expect, it } from "vitest"

import { MemorySigner } from "@automerge/automerge-subduction"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../../src/initSubduction.js"
import { pause } from "../../src/helpers/pause.js"
import { type PeerId } from "../../src/types.js"
import { SpyNetworkAdapter } from "../helpers/SpyNetworkAdapter.js"

const SERVICE_NAME = "test-service"
const HANDSHAKE_TIMEOUT_MS = 10_000

const WAVES = 6
const DOCS_PER_WAVE = 40

beforeAll(async () => {
  await initSubduction()
})

async function waitForCondition(
  fn: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 25
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await pause(intervalMs)
  }
  return false
}

interface SaveSample {
  callIndex: number
  sedimentreesBefore: number
  wallClockMs: number
  commitCount: number
}

interface WaveTimings {
  wave: number
  sedimentreesBefore: number
  flushMs: number
  perDocMs: number
  saveCalls: number
  avgSaveMs: number
  maxSaveMs: number
}

describe("subduction addCommitsBatch save path (no broadcast)", () => {
  it(
    "uses addCommitsBatch (not addBatch) and per-call latency stays bounded",
    async () => {
      const [senderAdapter, receiverAdapter] =
        SpyNetworkAdapter.createConnectedPair()

      const senderPeerId = "sender" as PeerId
      const receiverPeerId = "receiver" as PeerId

      const senderRepo = new Repo({
        peerId: senderPeerId,
        storage: new DummyStorageAdapter(),
        network: [],
        signer: new MemorySigner(),
        subductionAdapters: [
          { adapter: senderAdapter, serviceName: SERVICE_NAME, role: "connect" },
        ],
        sharePolicy: async () => true,
      })

      const receiverRepo = new Repo({
        peerId: receiverPeerId,
        storage: new DummyStorageAdapter(),
        network: [],
        signer: new MemorySigner(),
        subductionAdapters: [
          { adapter: receiverAdapter, serviceName: SERVICE_NAME, role: "connect" },
        ],
        sharePolicy: async () => true,
      })

      senderAdapter.peerCandidate(receiverPeerId)
      receiverAdapter.peerCandidate(senderPeerId)

      const senderSubduction = await senderRepo.subduction
      await receiverRepo.subduction

      const handshakeOk = await waitForCondition(async () => {
        const peers = await senderSubduction.getConnectedPeerIds()
        return peers.length > 0
      }, HANDSHAKE_TIMEOUT_MS)
      if (!handshakeOk) {
        throw new Error(`handshake did not complete within ${HANDSHAKE_TIMEOUT_MS}ms`)
      }

      // Hoist proto and originals so the finally block can restore them.
      const proto = Object.getPrototypeOf(senderSubduction) as {
        addCommitsBatch: (id: unknown, commits: unknown[]) => Promise<void>
        addBatch: (id: unknown, commits: unknown[], fragments: unknown[]) => Promise<void>
      }
      const originalAddCommitsBatch = proto.addCommitsBatch
      const originalAddBatch = proto.addBatch

      const samples: SaveSample[] = []
      const seenSids = new Set<string>()
      let addBatchCallCount = 0

      // Instrument via the prototype so every WASM wrapper instance
      // (including ones SubductionSource may have resolved independently)
      // goes through the spy.
      proto.addCommitsBatch = async function (
        this: unknown,
        id: { toString(): string },
        commits: unknown[]
      ): Promise<void> {
        const sedimentreesBefore = seenSids.size
        const callIndex = samples.length
        const t0 = performance.now()
        try {
          return await originalAddCommitsBatch.call(this, id as unknown, commits)
        } finally {
          const wallClockMs = performance.now() - t0
          seenSids.add(id.toString())
          samples.push({ callIndex, sedimentreesBefore, wallClockMs, commitCount: commits.length })
        }
      }

      proto.addBatch = async function (
        this: unknown,
        id: unknown,
        commits: unknown[],
        fragments: unknown[]
      ): Promise<void> {
        addBatchCallCount++
        return originalAddBatch.call(this, id, commits, fragments)
      }

      try {
        const waveTimings: WaveTimings[] = []

        for (let w = 0; w < WAVES; w++) {
          const sedimentreesBefore = seenSids.size
          const sampleStart = samples.length

          for (let i = 0; i < DOCS_PER_WAVE; i++) {
            const handle = senderRepo.create<{ counter: number }>()
            handle.change(d => {
              d.counter = w * DOCS_PER_WAVE + i
            })
          }

          const t0 = performance.now()
          await senderRepo.flush()
          const flushMs = performance.now() - t0

          const waveSamples = samples.slice(sampleStart)
          const saveCalls = waveSamples.length
          const avgSaveMs =
            saveCalls > 0
              ? waveSamples.reduce((s, c) => s + c.wallClockMs, 0) / saveCalls
              : 0
          const maxSaveMs =
            saveCalls > 0
              ? Math.max(...waveSamples.map(c => c.wallClockMs))
              : 0

          waveTimings.push({
            wave: w,
            sedimentreesBefore,
            flushMs,
            perDocMs: flushMs / DOCS_PER_WAVE,
            saveCalls,
            avgSaveMs,
            maxSaveMs,
          })
        }

        // Final flush + settle: some addCommitsBatch calls fire slightly
        // after each wave's flush() returns (async entry init). One more
        // flush + pause captures all stragglers before asserting call count.
        await senderRepo.flush()
        await pause(500)

        const fmt = (n: number, digits = 2) =>
          Number.isFinite(n) ? n.toFixed(digits) : "—"
        const lines = [
          `=== subduction.addCommitsBatch latency vs sedimentree count ===`,
          `wave | sids before | docs | flush ms | per-doc ms | save calls | avg save ms | max save ms`,
          `-----+-------------+------+----------+------------+------------+-------------+------------`,
        ]
        for (const w of waveTimings) {
          lines.push(
            [
              w.wave.toString().padStart(4),
              w.sedimentreesBefore.toString().padStart(11),
              DOCS_PER_WAVE.toString().padStart(4),
              fmt(w.flushMs, 1).padStart(8),
              fmt(w.perDocMs, 2).padStart(10),
              w.saveCalls.toString().padStart(10),
              fmt(w.avgSaveMs, 2).padStart(11),
              fmt(w.maxSaveMs, 2).padStart(10),
            ].join(" | ")
          )
        }
        console.log("\n" + lines.join("\n") + "\n")

        // 1. addBatch must never be called after the fix
        expect(
          addBatchCallCount,
          `addBatch was called ${addBatchCallCount} times — SubductionSource must use addCommitsBatch after the fix`
        ).toBe(0)

        // 2. addCommitsBatch must be called for (nearly) every doc.
        // 1–3 calls per run fire through WASM-internal paths that don't
        // surface to the JS prototype spy; we allow a slack of 3.
        // A broken save path produces 0 calls — this threshold catches it.
        const totalSaveCalls = samples.length
        expect(
          totalSaveCalls,
          `expected addCommitsBatch to be called for every doc; got ${totalSaveCalls} across ${WAVES} waves of ${DOCS_PER_WAVE}`
        ).toBeGreaterThanOrEqual(WAVES * DOCS_PER_WAVE - 3)

        // 3. Per-call latency stays bounded (storage-only, no broadcast)
        const firstWave = waveTimings[0]
        const lastWave = waveTimings[waveTimings.length - 1]
        const saveRatio =
          firstWave.avgSaveMs > 0
            ? lastWave.avgSaveMs / firstWave.avgSaveMs
            : Infinity

        expect(
          saveRatio,
          `avg addCommitsBatch ms grew ${fmt(saveRatio, 1)}× ` +
            `(${fmt(firstWave.avgSaveMs)}ms @ ${firstWave.sedimentreesBefore} sids → ` +
            `${fmt(lastWave.avgSaveMs)}ms @ ${lastWave.sedimentreesBefore} sids). ` +
            `addCommitsBatch is storage-only so latency must stay ~constant in N.`
        ).toBeLessThan(3)
      } finally {
        proto.addCommitsBatch = originalAddCommitsBatch
        proto.addBatch = originalAddBatch
        await Promise.race([
          Promise.all([senderRepo.shutdown(), receiverRepo.shutdown()]),
          pause(2000),
        ])
      }
    },
    HANDSHAKE_TIMEOUT_MS + 60_000
  )
})
