/**
 * Per-document network-traffic accounting test for SubductionSource.
 *
 * Wires two `Repo`s together via paired in-memory `SpyNetworkAdapter`s,
 * counts every Subduction protocol frame in each direction, separates
 * the handshake-fixed cost from per-doc replication cost, and emits a
 * structured per-doc frame/byte budget.
 *
 * The goal is to reproduce — at the bare `automerge-repo` layer with
 * no DXOS, no DO, no echo-db — the per-doc traffic ratio observed in
 * dxos's `edge-subduction-sync.test.ts`. See `MESSAGE-BUDGET-README.md`
 * for context, current numbers, and how to read the summary.
 *
 * Bump `NUMBER_DOCUMENTS` to investigate scaling. The single hard
 * assertion is convergence (receiver sees every doc); the frame/byte
 * counts are *measured*, not asserted, so this test discovers the
 * baseline rather than baking it in.
 */

import { beforeAll, describe, expect, it } from "vitest"

import { MemorySigner } from "@automerge/automerge-subduction"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../../src/initSubduction.js"
import { pause } from "../../src/helpers/pause.js"
import { type AutomergeUrl, type PeerId } from "../../src/types.js"
import { SpyNetworkAdapter } from "../helpers/SpyNetworkAdapter.js"

const NUMBER_DOCUMENTS = 10

const SERVICE_NAME = "test-service"
const HANDSHAKE_TIMEOUT_MS = 10_000
const CONVERGENCE_TIMEOUT_MS = 50_000

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

describe("subduction network traffic accounting", () => {
  it(
    `replicating ${NUMBER_DOCUMENTS} docs between two repos`,
    async () => {
      // ── Setup ────────────────────────────────────────────────────
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
          {
            adapter: senderAdapter,
            serviceName: SERVICE_NAME,
            role: "connect",
          },
        ],
        sharePolicy: async () => true,
      })

      const receiverRepo = new Repo({
        peerId: receiverPeerId,
        storage: new DummyStorageAdapter(),
        network: [],
        signer: new MemorySigner(),
        subductionAdapters: [
          {
            adapter: receiverAdapter,
            serviceName: SERVICE_NAME,
            role: "connect",
          },
        ],
        sharePolicy: async () => true,
      })

      // Bootstrap discovery: tell each spy adapter about the remote
      // peer id, mirroring what `connectRepos` does for `Repo` tests.
      senderAdapter.peerCandidate(receiverPeerId)
      receiverAdapter.peerCandidate(senderPeerId)

      // ── Handshake boundary ───────────────────────────────────────
      // `acceptTransport`/`connectTransport` resolve only on disconnect,
      // so we use `getConnectedPeerIds()` as the precise completion
      // signal. Both peers must have added the other to consider the
      // handshake done.
      const senderSubduction = await senderRepo.subduction
      const receiverSubduction = await receiverRepo.subduction

      const handshakeDone = await waitForCondition(async () => {
        const [s, r] = await Promise.all([
          senderSubduction.getConnectedPeerIds(),
          receiverSubduction.getConnectedPeerIds(),
        ])
        const sIds = s.map(p => p.toString())
        const rIds = r.map(p => p.toString())
        return sIds.length > 0 && rIds.length > 0
      }, HANDSHAKE_TIMEOUT_MS)

      if (!handshakeDone) {
        throw new Error(
          `Handshake did not complete within ${HANDSHAKE_TIMEOUT_MS}ms`
        )
      }

      const handshakeSender = senderAdapter.snapshot()
      const handshakeReceiver = receiverAdapter.snapshot()

      // ── Document creation (all-at-once) ──────────────────────────
      const t0 = performance.now()
      const urls: AutomergeUrl[] = []
      for (let i = 0; i < NUMBER_DOCUMENTS; i++) {
        const handle = senderRepo.create<{ counter: number; name: string }>()
        handle.change(d => {
          d.counter = i
          d.name = `doc-${i}`
        })
        urls.push(handle.url)
      }
      await senderRepo.flush()

      // ── Convergence ──────────────────────────────────────────────
      let readyCount = 0
      const converged = await waitForCondition(async () => {
        readyCount = 0
        for (const url of urls) {
          const progress = receiverRepo.findWithProgress<{
            counter: number
            name: string
          }>(url)
          const state = progress.peek()
          if (state.state === "ready") readyCount++
        }
        return readyCount === NUMBER_DOCUMENTS
      }, CONVERGENCE_TIMEOUT_MS)

      const wallClockMs = performance.now() - t0

      // ── Snapshot + report ────────────────────────────────────────
      const totalSender = senderAdapter.snapshot()
      const totalReceiver = receiverAdapter.snapshot()

      const handshake = {
        senderToReceiver: {
          frames: handshakeSender.out.frames,
          bytes: handshakeSender.out.bytes,
        },
        receiverToSender: {
          frames: handshakeReceiver.out.frames,
          bytes: handshakeReceiver.out.bytes,
        },
      }

      const replication = {
        senderToReceiver: {
          frames: totalSender.out.frames - handshakeSender.out.frames,
          bytes: totalSender.out.bytes - handshakeSender.out.bytes,
        },
        receiverToSender: {
          frames: totalReceiver.out.frames - handshakeReceiver.out.frames,
          bytes: totalReceiver.out.bytes - handshakeReceiver.out.bytes,
        },
      }

      const totalFrames =
        replication.senderToReceiver.frames +
        replication.receiverToSender.frames
      const totalBytes =
        replication.senderToReceiver.bytes +
        replication.receiverToSender.bytes

      const summary = {
        docCount: NUMBER_DOCUMENTS,
        converged,
        readyCount,
        handshake,
        replication: {
          ...replication,
          perDoc: {
            senderToReceiverFrames:
              replication.senderToReceiver.frames / NUMBER_DOCUMENTS,
            senderToReceiverBytes:
              replication.senderToReceiver.bytes / NUMBER_DOCUMENTS,
            receiverToSenderFrames:
              replication.receiverToSender.frames / NUMBER_DOCUMENTS,
            receiverToSenderBytes:
              replication.receiverToSender.bytes / NUMBER_DOCUMENTS,
          },
        },
        totals: {
          frames: totalFrames,
          bytes: totalBytes,
          framesPerDoc: totalFrames / NUMBER_DOCUMENTS,
          bytesPerDoc: totalBytes / NUMBER_DOCUMENTS,
        },
        wallClockSyncMs: wallClockMs,
        controlFrames:
          totalSender.control.frames + totalReceiver.control.frames,
        sizes: {
          senderOut: totalSender.out.sizes,
          receiverOut: totalReceiver.out.sizes,
        },
      }

      const human = formatSummary(summary)
      console.log("\n" + human + "\n")

      // ── Hard assertion ───────────────────────────────────────────
      if (readyCount !== NUMBER_DOCUMENTS) {
        throw new Error(
          `Convergence timed out: only ${readyCount}/${NUMBER_DOCUMENTS} docs ready after ${CONVERGENCE_TIMEOUT_MS}ms.\n${human}`
        )
      }

      expect(readyCount).toBe(NUMBER_DOCUMENTS)

      // Shutdown sequentially with a timeout — a shutdown on one peer
      // can cancel in-flight requests on the other and surface noisy
      // "request timed out" errors. We've already measured what we
      // need; bound this so the test doesn't hang on cleanup.
      await Promise.race([
        Promise.all([senderRepo.shutdown(), receiverRepo.shutdown()]),
        pause(2000),
      ])
    },
    HANDSHAKE_TIMEOUT_MS + CONVERGENCE_TIMEOUT_MS + 10_000
  )
})

// ── Output helpers ────────────────────────────────────────────────────

interface BudgetSummary {
  docCount: number
  converged: boolean
  readyCount: number
  handshake: {
    senderToReceiver: { frames: number; bytes: number }
    receiverToSender: { frames: number; bytes: number }
  }
  replication: {
    senderToReceiver: { frames: number; bytes: number }
    receiverToSender: { frames: number; bytes: number }
    perDoc: {
      senderToReceiverFrames: number
      senderToReceiverBytes: number
      receiverToSenderFrames: number
      receiverToSenderBytes: number
    }
  }
  totals: {
    frames: number
    bytes: number
    framesPerDoc: number
    bytesPerDoc: number
  }
  wallClockSyncMs: number
  controlFrames: number
  sizes: { senderOut: number[]; receiverOut: number[] }
}

function formatSummary(s: BudgetSummary): string {
  const fmt = (n: number, digits = 2) =>
    Number.isInteger(n) ? n.toString() : n.toFixed(digits)
  const lines = [
    `=== Subduction message budget: ${s.docCount} docs ===`,
    `handshake phase:`,
    `  sender   -> receiver  frames=${s.handshake.senderToReceiver.frames}  bytes=${s.handshake.senderToReceiver.bytes}`,
    `  receiver -> sender    frames=${s.handshake.receiverToSender.frames}  bytes=${s.handshake.receiverToSender.bytes}`,
    `post-handshake (replication):`,
    `  sender   -> receiver  frames=${s.replication.senderToReceiver.frames}  bytes=${s.replication.senderToReceiver.bytes}  (${fmt(s.replication.perDoc.senderToReceiverFrames)} per doc, ${fmt(s.replication.perDoc.senderToReceiverBytes)} bytes per doc)`,
    `  receiver -> sender    frames=${s.replication.receiverToSender.frames}  bytes=${s.replication.receiverToSender.bytes}  (${fmt(s.replication.perDoc.receiverToSenderFrames)} per doc, ${fmt(s.replication.perDoc.receiverToSenderBytes)} bytes per doc)`,
    `totals:`,
    `  total frames        = ${s.totals.frames}`,
    `  total bytes         = ${s.totals.bytes}`,
    `  total frames/doc    = ${fmt(s.totals.framesPerDoc)}`,
    `  total bytes/doc     = ${fmt(s.totals.bytesPerDoc)}`,
    `  wall-clock sync ms  = ${fmt(s.wallClockSyncMs, 1)}`,
    `control frames (arrive/welcome/leave): ${s.controlFrames}`,
    `convergence: ${s.readyCount}/${s.docCount}${s.converged ? "" : " (TIMED OUT)"}`,
  ]
  return lines.join("\n")
}
