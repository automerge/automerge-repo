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
import { decodeHeads, parseAutomergeUrl } from "../../src/AutomergeUrl.js"
import { toSedimentreeId } from "../../src/subduction/helpers.js"
import {
  type AutomergeUrl,
  type DocumentId,
  type PeerId,
} from "../../src/types.js"
import { SpyNetworkAdapter } from "../helpers/SpyNetworkAdapter.js"

const NUMBER_DOCUMENTS = 100

const SERVICE_NAME = "test-service"
const HANDSHAKE_TIMEOUT_MS = 10_000
const CONVERGENCE_TIMEOUT_MS = 50_000
const QUIESCE_MS = 30_000

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

      // ── Convergence: ready state ─────────────────────────────────
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

      // ── Convergence: content equality ────────────────────────────
      // `ready` only means the handle has *some* heads. Verify that
      // every doc's content actually matches what the sender wrote.
      // Mismatches here are a real replication bug, distinct from the
      // heads-divergence representation mismatch we check later.
      const contentMismatches: Array<{
        url: AutomergeUrl
        local?: { counter: number; name: string }
        remote?: { counter: number; name: string }
      }> = []
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]
        const senderHandle =
          senderRepo.handles[parseAutomergeUrl(url).documentId]
        const progress = receiverRepo.findWithProgress<{
          counter: number
          name: string
        }>(url)
        const state = progress.peek()
        const remote = (
          state.state === "ready" ? state.handle.doc() : undefined
        ) as { counter: number; name: string } | undefined
        const local = senderHandle?.doc() as
          | { counter: number; name: string }
          | undefined
        if (
          !remote ||
          !local ||
          remote.counter !== local.counter ||
          remote.name !== local.name
        ) {
          contentMismatches.push({ url, local, remote })
        }
      }
      console.log(
        `content equality after ready: ${urls.length - contentMismatches.length}/${urls.length} docs match` +
          (contentMismatches.length === 0
            ? ""
            : `; ${contentMismatches.length} mismatched (first: ${JSON.stringify(contentMismatches[0])})`)
      )

      const wallClockMs = performance.now() - t0

      // ── Quiesce ──────────────────────────────────────────────────
      // Give Subduction's background work (fragment broadcast, sync
      // completion callbacks, fragment store updates) a generous
      // window before we sample heads. The bug we want to surface
      // here is structural, not a timing race — but waiting 30s
      // distinguishes "race" from "permanent representation
      // mismatch".
      console.log(`waiting ${QUIESCE_MS / 1000}s for subduction to quiesce...`)
      await pause(QUIESCE_MS)

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

      // ── Heads-divergence soft check ──────────────────────────────
      // Compares per-doc tip sets between the sender's automerge
      // change graph (handle.heads()) and the receiver's sedimentree
      // tip set (subduction.getAllHeads()). The sedimentree set can
      // include fragment heads — depth-≥1 commit IDs that, by
      // construction, start with one or more 0x00 bytes — which the
      // automerge-side API never surfaces. This is a known
      // representation mismatch between the two layers (see PR
      // description for the writeup); we surface it here as
      // diagnostic output but don't fail the test on it.
      const headsReport = await collectHeadsDivergence(
        senderRepo,
        receiverRepo,
        urls
      )
      console.log(formatHeadsReport(headsReport) + "\n")

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
    HANDSHAKE_TIMEOUT_MS + CONVERGENCE_TIMEOUT_MS + QUIESCE_MS + 10_000
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

// ── Heads-divergence helpers ──────────────────────────────────────────

interface PerDocHeads {
  documentId: DocumentId
  /** Sender's automerge-graph tips (commit hashes only). */
  local: string[]
  /** Receiver's sedimentree tips (commits ∪ fragment heads). */
  remote: string[]
  /** Heads in `local` not present in `remote`. */
  localOnly: string[]
  /** Heads in `remote` not present in `local`. */
  remoteOnly: string[]
  /** Heads present on both sides. */
  shared: string[]
}

interface HeadsDivergenceReport {
  total: number
  matching: number
  divergent: PerDocHeads[]
  /**
   * Subset of `divergent` where the only "extra" tip on either side
   * starts with `00` — i.e. consistent with the
   * fragment-head-vs-commit-tip representation mismatch.
   */
  divergentDueToFragmentLikeHead: PerDocHeads[]
  /** Divergent docs that don't fit the fragment-like pattern. */
  divergentOther: PerDocHeads[]
  /** Docs we couldn't compare (no handle on one side). */
  uncompared: DocumentId[]
}

const startsWithZeroByte = (hex: string) => hex.startsWith("00")

const allExtrasFragmentLike = (h: PerDocHeads) =>
  (h.localOnly.length > 0 || h.remoteOnly.length > 0) &&
  h.localOnly.every(startsWithZeroByte) &&
  h.remoteOnly.every(startsWithZeroByte)

async function collectHeadsDivergence(
  senderRepo: Repo,
  receiverRepo: Repo,
  urls: AutomergeUrl[]
): Promise<HeadsDivergenceReport> {
  const subduction = await receiverRepo.subduction
  const allHeads = await subduction.getAllHeads()
  const remoteByDocId = new Map<string, string[]>()
  for (const sh of allHeads) {
    // SedimentreeId.toString() is keyed off the full 32-byte id;
    // we match by that instead of converting back to DocumentId so
    // we don't depend on the bs58 round-trip.
    remoteByDocId.set(
      sh.id.toString(),
      sh.heads.map(h => h.toHexString())
    )
  }

  const divergent: PerDocHeads[] = []
  const uncompared: DocumentId[] = []
  let matching = 0

  for (const url of urls) {
    const { documentId } = parseAutomergeUrl(url)
    const senderHandle = senderRepo.handles[documentId]
    if (!senderHandle) {
      uncompared.push(documentId)
      continue
    }

    // handle.heads() returns base58check-encoded `UrlHeads`; convert
    // to lowercase hex to match `CommitId.toHexString()` returned by
    // subduction.getAllHeads().
    const local = decodeHeads(senderHandle.heads()).slice().sort()
    const sid = toSedimentreeId(documentId)
    const remote = (remoteByDocId.get(sid.toString()) ?? []).slice().sort()

    const localSet = new Set(local)
    const remoteSet = new Set(remote)
    const shared = local.filter(h => remoteSet.has(h))
    const localOnly = local.filter(h => !remoteSet.has(h))
    const remoteOnly = remote.filter(h => !localSet.has(h))

    if (localOnly.length === 0 && remoteOnly.length === 0) {
      matching++
    } else {
      divergent.push({
        documentId,
        local,
        remote,
        localOnly,
        remoteOnly,
        shared,
      })
    }
  }

  const divergentDueToFragmentLikeHead = divergent.filter(allExtrasFragmentLike)
  const divergentOther = divergent.filter(d => !allExtrasFragmentLike(d))

  return {
    total: urls.length,
    matching,
    divergent,
    divergentDueToFragmentLikeHead,
    divergentOther,
    uncompared,
  }
}

function formatHeadsReport(r: HeadsDivergenceReport): string {
  const lines: string[] = [
    `=== Heads divergence (sender handle.heads vs receiver subduction.getAllHeads) ===`,
    `total docs:                    ${r.total}`,
    `matching head sets:            ${r.matching}`,
    `divergent:                     ${r.divergent.length}`,
    `  with 00-prefixed extras:     ${r.divergentDueToFragmentLikeHead.length}  (suspected fragment-head bug)`,
    `  other:                       ${r.divergentOther.length}`,
    `uncompared (no sender handle): ${r.uncompared.length}`,
  ]

  const sample = r.divergent.slice(0, 3)
  if (sample.length > 0) {
    lines.push(`first ${sample.length} divergent doc(s):`)
    for (const d of sample) {
      lines.push(`  doc ${d.documentId}`)
      lines.push(`    local  (handle.heads):       [${d.local.join(", ")}]`)
      lines.push(`    remote (subduction heads):   [${d.remote.join(", ")}]`)
      lines.push(`    shared:                      [${d.shared.join(", ")}]`)
      lines.push(`    local-only:                  [${d.localOnly.join(", ")}]`)
      lines.push(
        `    remote-only:                 [${d.remoteOnly.join(", ")}]`
      )
    }
  }

  if (r.divergent.length > 0 && r.divergentDueToFragmentLikeHead.length > 0) {
    lines.push(
      `note: every "extra" head in the suspected-fragment bucket starts with 0x00,`
    )
    lines.push(
      `      which is the fragment-head signature documented in the dxos/subduction`
    )
    lines.push(
      `      readme. handle.heads() never returns fragment heads; subduction's`
    )
    lines.push(
      `      getAllHeads() does. that's a known representation mismatch — not a`
    )
    lines.push(`      replication failure.`)
  }

  return lines.join("\n")
}
