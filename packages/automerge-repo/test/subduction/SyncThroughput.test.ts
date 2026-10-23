/**
 * Sync throughput budget for the Subduction path.
 *
 * Efficient sync is the point of the sedimentree design, so these tests
 * pin what it costs on the wire — bytes, frames, rounds, items — for the
 * operations users actually do, against an in-process server.
 *
 * Two kinds of test:
 *
 * - **budget** (`it`): the current cost, checked against the committed
 *   `SyncThroughput.baseline.json` with a small tolerance. Fails when sync
 *   gets more expensive, and also when it gets substantially cheaper, so
 *   a gain is written into the baseline instead of eroding unnoticed.
 *   Regenerate (from the repo root, like every test here) with
 *   `UPDATE_SYNC_BASELINES=1 npx vitest run SyncThroughput`;
 *   `SYNC_THROUGHPUT_REPORT=1` prints every raw measurement.
 *
 * Every scenario first checks that the operation completed (the server
 * holds the whole document, the reader sees the right text): lower is
 * better, so a sync that stopped halfway must not read as an improvement.
 *
 * - **target** (`it.fails`): the ideal, for a known inefficiency. These
 *   pass while the bug exists. When a fix lands the target starts
 *   holding, `it.fails` reports a failure, and whoever fixed it promotes
 *   the target to a plain `it` (and refreshes the baseline).
 *
 * Cause ids match the oversync investigation:
 *
 *   C1  every local save runs a full sync round that re-sends a fingerprint
 *       of every item in the sedimentree, so per-change cost grows with
 *       history
 *   C2  a fragment's head is never stored as a loose commit, so nothing is
 *       ever recognised as covered by a fragment: loose commits are served
 *       alongside the fragment that already contains them
 *   C3  `#save` re-arms a sync round even when it stored nothing: two
 *       rounds per find, and every subscriber echoes a round per change
 *   C3b `#doSync` flushes the pending save before its round; that save
 *       finishes while the round is in flight and sets `needsResync`, so
 *       a fresh import runs the same round twice (found writing these
 *       tests; the C3 fix does not change it)
 *   C4  client compaction deletes absorbed loose commits the server still
 *       serves, so they are downloaded again on reload
 *   C5  cold fetch ships each loose commit in its own signed envelope
 *       with an uncompressed change blob
 *   C6  the server acks every ingested item with a HeadsUpdate carrying
 *       its full head list: O(n²) bytes on a bulk upload
 *   C7  overlapping rounds upload the same commit more than once
 *
 * Not covered here: C8 (a long-lived worker never detaches docs; there is
 * no API to close a doc to measure against), C13 (u16 item counts wrap at
 * 65,536 — too large for this suite) and the ingest newness bug (only
 * reachable once C2 is fixed). Those live with the Rust-side tests.
 *
 * Every document is built from fixed actors, timestamps and text, so
 * change hashes and fragment boundaries are the same on every run; the
 * byte counts are deterministic (signatures and ids are fixed-size). The
 * one exception is how many heads each HeadsUpdate lists, which depends
 * on the order the server ingests a burst; those carry a tolerance.
 *
 * Counters are read once `settle()` reports the system idle: no pending
 * timer (throttled save, re-armed round, backoff) and no frame in flight.
 * A regression that delays a round therefore still lands in the window.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { existsSync } from "fs"
import path from "path"
import { next as A } from "@automerge/automerge"
import { SyncMessage } from "@automerge/automerge-subduction"
import { MessageChannelNetworkAdapter } from "../../../automerge-repo-network-messagechannel/src/index.js"
import { Repo } from "../../src/Repo.js"
import type { DocHandle } from "../../src/DocHandle.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { binaryToDocumentId } from "../../src/AutomergeUrl.js"
import type { BinaryDocumentId, DocumentId, PeerId } from "../../src/types.js"
import { toSedimentreeId } from "../../src/subduction/helpers.js"
import { awaitSubductionConnected } from "../helpers/awaitSubductionConnected.js"
import { awaitDoc } from "../helpers/awaitDoc.js"
import { wait } from "../helpers/wait.js"
import { SyncBudget } from "../helpers/syncBudget.js"
import {
  HEADS_UPDATE_ENVELOPE,
  MeteredEndpoint,
  WireMeter,
  activeIntervals,
  batchSyncRequestItems,
  decodeBatchSyncResponse,
  headsUpdateHeads,
  meterMessagePort,
  pendingTimeouts,
  settle,
  startMeteredServer,
  trackTimers,
  timerMark,
  type MeteredServer,
  type WireWindow,
} from "../helpers/syncWire.js"

// Before any Repo exists, so every timer it schedules is visible to settle().
trackTimers()

// Under happy-dom `import.meta.url` is not a file: URL. Vitest only runs
// from the repo root (the package config inherits the root `projects`),
// so resolve from there.
const BASELINE = path.resolve(
  "packages/automerge-repo/test/subduction/SyncThroughput.baseline.json"
)
if (!existsSync(BASELINE) && !process.env.UPDATE_SYNC_BASELINES) {
  throw new Error(`${BASELINE} not found: run vitest from the repo root`)
}
const budget = new SyncBudget(BASELINE)
afterAll(() => budget.save())

/** The save throttle in `SubductionSource.attach` (source.ts). */
const SAVE_THROTTLE_MS = 100

/** `SYNC_THROUGHPUT_REPORT=1` prints every raw measurement. */
function report(scenario: string, m: Record<string, number>) {
  if (!process.env.SYNC_THROUGHPUT_REPORT) return
  // happy-dom swallows console output; write to the real stdout.
  process.stdout.write(`${scenario} ${JSON.stringify(m, null, 2)}\n`)
}

// ── Deterministic documents ───────────────────────────────────────────

type TextDoc = { text: string }

const ACTOR = "5ec0de5ec0de5ec0de5ec0de5ec0de00"

/**
 * `n` changes, each typing one character, from a fixed actor at time 0
 * with seeded text. Prefixes are shared: `typed(n)` is the first `n`
 * changes of `typed(n + k)`, so "one more keystroke" is `typed(n + 1)`.
 */
const typedCache: A.Doc<TextDoc>[] = []
function typed(n: number): A.Doc<TextDoc> {
  if (typedCache[n]) return typedCache[n]
  let seed = 1
  const nextChar = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const r = seed % 27
    return r === 26 ? " " : String.fromCharCode(97 + r)
  }
  let doc = A.change(A.init<TextDoc>({ actor: ACTOR }), { time: 0 }, d => {
    d.text = ""
  })
  for (let i = 1; i < n; i++) {
    doc = A.change(doc, { time: 0 }, d => {
      A.splice(d, ["text"], d.text.length, 0, nextChar())
    })
  }
  return (typedCache[n] = doc)
}

const changesOf = (n: number) => A.getAllChanges(typed(n))
const saveSize = (n: number) => A.save(typed(n)).byteLength

let docSeq = 0
/** Fixed document ids, so sedimentree ids are the same on every run. */
function nextDocId(): DocumentId {
  docSeq++
  return binaryToDocumentId(
    Uint8Array.from(
      { length: 16 },
      (_, i) => (i * 31 + docSeq) & 0xff
    ) as BinaryDocumentId
  )
}

const parentsCache = new WeakMap<object, Map<string, string[]>>()
/** Change hash → deps, for every change in `doc`. */
function parentsOf(doc: A.Doc<unknown>): Map<string, string[]> {
  let parents = parentsCache.get(doc)
  if (!parents) {
    parents = new Map()
    for (const c of A.getAllChanges(doc)) {
      const d = A.decodeChange(c)
      parents.set(d.hash!, d.deps)
    }
    parentsCache.set(doc, parents)
  }
  return parents
}

/** The commits a fragment contains: `head` and its ancestors, down to (not including) `boundary`. */
function fragmentMembers(
  doc: A.Doc<unknown>,
  head: string,
  boundary: string[]
): Set<string> {
  const parents = parentsOf(doc)
  const stop = new Set(boundary)
  const out = new Set<string>()
  const stack = [head]
  while (stack.length) {
    const h = stack.pop()!
    if (stop.has(h) || out.has(h)) continue
    out.add(h)
    stack.push(...(parents.get(h) ?? []))
  }
  return out
}

/**
 * What the server holds of `doc`: its loose commits, how many of those a
 * server fragment already covers (C2), and how many changes of `doc` it
 * holds neither loose nor inside a fragment (0 once a push completed).
 */
async function serverHoldings(
  server: MeteredServer,
  documentId: DocumentId,
  doc: A.Doc<unknown>
) {
  const sid = toSedimentreeId(documentId)
  const commits = (await server.subduction.getCommits(sid)) ?? []
  const fragments = (await server.subduction.getFragments(sid)) ?? []
  const inFragments = new Set<string>()
  for (const f of fragments) {
    const members = fragmentMembers(
      doc,
      f.head.toHexString(),
      f.boundary.map(b => b.toHexString())
    )
    for (const h of members) inFragments.add(h)
  }
  const loose = commits.map(c => c.commitId.toHexString())
  const held = new Set([...loose, ...inFragments])
  return {
    loose: loose.length,
    covered: loose.filter(h => inFragments.has(h)).length,
    missing: [...parentsOf(doc).keys()].filter(h => !held.has(h)).length,
  }
}

// ── Harness ───────────────────────────────────────────────────────────

interface Client {
  name: string
  repo: Repo
  endpoint: MeteredEndpoint
  meter: WireMeter
  storage: DummyStorageAdapter
  shutdown(): Promise<void>
}

/** One server and the clients attached to it, torn down together. */
class World {
  #cleanups: Array<() => Promise<void> | void> = []
  server!: MeteredServer

  async start() {
    this.server = await startMeteredServer()
    this.#cleanups.push(() => this.server.close())
    return this
  }

  async client(name: string, storage = new DummyStorageAdapter()) {
    const endpoint = new MeteredEndpoint(this.server.url, name)
    const repo = new Repo({
      peerId: name as PeerId,
      storage,
      subductionWebsocketEndpoints: [endpoint],
    })
    let closed: Promise<void> | null = null
    const shutdown = () => (closed ??= repo.shutdown())
    this.#cleanups.push(shutdown)
    await awaitSubductionConnected(repo, { timeout: 5000 })
    await settle()
    const client: Client = {
      name,
      repo,
      endpoint,
      meter: endpoint.meter,
      storage,
      shutdown,
    }
    return client
  }

  onClose(cleanup: () => Promise<void> | void) {
    this.#cleanups.push(cleanup)
  }

  async close() {
    for (const cleanup of this.#cleanups.reverse()) await cleanup()
    this.#cleanups = []
  }
}

/** Import `typed(n)` in one step (bulk import / paste / migration). */
function importDoc(repo: Repo, n: number) {
  return repo.import<TextDoc>(A.save(typed(n)), { docId: nextDocId() })
}

/**
 * Build `typed(n)` the way a typing user does: the doc grows a few
 * characters at a time and each step is saved and synced before the next.
 */
async function typeDoc(repo: Repo, n: number, step = 50) {
  const changes = changesOf(n)
  const first = A.applyChanges(A.init<TextDoc>(), changes.slice(0, 1))[0]
  const handle = repo.import<TextDoc>(A.save(first), { docId: nextDocId() })
  for (let i = 1; i < n; i += step) {
    const chunk = changes.slice(i, i + step)
    handle.update(d => A.applyChanges(d, chunk)[0])
    await repo.flush([handle.documentId])
    await settle()
  }
  await settle()
  return handle
}

/** Make the next keystroke of `typed` on a handle currently at `n` changes. */
function typeOneMore(handle: DocHandle<TextDoc>, n: number): number {
  const change = changesOf(n + 1)[n]
  handle.update(d => A.applyChanges(d, [change])[0])
  return change.byteLength
}

/** Distinct commit ids in a window's uploaded LooseCommit frames. */
function uploadedCommitIds(w: WireWindow): string[] {
  return w
    .select("up", "LooseCommit")
    .map(f => SyncMessage.fromBytes(f.bytes).commit!.commitId.toHexString())
}

/** Fingerprints sent in a window's BatchSyncRequests (C1: the summary of history). */
function requestItems(w: WireWindow): number {
  return w
    .select("up", "BatchSyncRequest")
    .reduce((n, f) => n + batchSyncRequestItems(f.bytes), 0)
}

/**
 * HeadsUpdate acks received in a window (C6). Their bytes split exactly
 * into a fixed envelope per ack plus 32 B per listed head; only the head
 * count depends on ingest order, so it is budgeted separately.
 */
function headsUpdates(w: WireWindow) {
  const frames = w.select("down", "HeadsUpdate")
  const heads = frames.reduce((n, f) => n + headsUpdateHeads(f.bytes), 0)
  const bytes = frames.reduce((n, f) => n + f.bytes.byteLength, 0)
  return {
    acks: frames.length,
    heads,
    envelopeBytesPerAck: frames.length
      ? (bytes - 32 * heads) / frames.length
      : HEADS_UPDATE_ENVELOPE,
  }
}

/**
 * Loose commits in a window's BatchSyncResponses that are also inside a
 * fragment shipped in the same response.
 */
function coveredLooseInResponses(w: WireWindow, doc: A.Doc<unknown>) {
  let loose = 0
  let covered = 0
  let envelopeBytes = 0
  for (const frame of w.select("down", "BatchSyncResponse")) {
    const r = decodeBatchSyncResponse(frame.bytes)
    const inFragments = new Set<string>()
    for (const f of r.fragments) {
      for (const h of fragmentMembers(doc, f.head, f.boundary)) {
        inFragments.add(h)
      }
    }
    loose += r.commits.length
    covered += r.commits.filter(c => inFragments.has(c.id)).length
    envelopeBytes += r.commits.reduce((n, c) => n + c.envelopeBytes, 0)
  }
  return { loose, covered, envelopeBytes }
}

// Every budget below assumes this exact document. If Automerge changes
// its encoding or fragment boundaries, this fails first: regenerate the
// baselines rather than reading the drift as a sync regression.
describe("Sync throughput: fixture", () => {
  it("the seeded 1000-keystroke document has a fixed shape", () => {
    expect(saveSize(1000)).toBe(814)
    expect(A.getFragmentMetadata(typed(1000), 0).length).toBe(222)
    expect(A.getFragmentMetadata(typed(1000), { start: 1 }).length).toBe(3)
  })
})

// ── Typed history: push, server state, cold fetch, reloads ────────────

describe("Sync throughput: a 1000-keystroke document", () => {
  const N = 1000
  const world = new World()
  const m: Record<string, number> = {}

  beforeAll(async () => {
    await world.start()
    const alice = await world.client("alice")

    // Push: alice types the whole document while connected.
    const pushMark = alice.meter.mark()
    const handle = await typeDoc(alice.repo, N)
    const push = alice.meter.since(pushMark)
    const held = await serverHoldings(world.server, handle.documentId, typed(N))
    // Complete before measured: a push that stopped early looks cheaper.
    expect(held.missing).toBe(0)
    const ids = uploadedCommitIds(push)
    const acks = headsUpdates(push)
    m.pushUpBytes = push.bytes("up")
    m.pushRounds = push.count("up", "BatchSyncRequest")
    m.pushRequestItems = requestItems(push)
    m.pushLooseCommitFrames = ids.length
    m.pushDistinctLooseCommits = new Set(ids).size
    m.pushHeadsUpdates = acks.acks
    m.pushHeadsUpdateHeads = acks.heads
    m.pushHeadsUpdateEnvelopeBytes = acks.envelopeBytesPerAck

    // What the server ends up holding.
    m.serverLooseCommits = held.loose
    m.serverCoveredLooseCommits = held.covered

    // Cold fetch by a fresh client.
    const fred = await world.client("fred")
    const fetchMark = fred.meter.mark()
    const fetched = await fred.repo.find<TextDoc>(handle.url)
    await settle()
    expect(fetched.doc().text).toBe(typed(N).text)
    const fetch = fred.meter.since(fetchMark)
    const resp = coveredLooseInResponses(fetch, typed(N))
    m.fetchDownBytes = fetch.bytes("down")
    m.fetchRounds = fetch.count("up", "BatchSyncRequest")
    m.fetchLooseCommits = resp.loose
    m.fetchCoveredLooseCommits = resp.covered
    m.fetchEnvelopeBytesPerLooseCommit = resp.loose
      ? resp.envelopeBytes / resp.loose
      : 0

    // Reader reload: fred's storage, new Repo, document unchanged.
    await fred.shutdown()
    const fred2 = await world.client("fred-reloaded", fred.storage)
    const warmMark = fred2.meter.mark()
    const warm = await fred2.repo.find<TextDoc>(handle.url)
    await settle()
    expect(warm.doc().text).toBe(typed(N).text)
    const warmW = fred2.meter.since(warmMark)
    m.readerReloadBytes = warmW.bytes("up") + warmW.bytes("down")
    m.readerReloadRounds = warmW.count("up", "BatchSyncRequest")
    m.readerReloadRequestItems = requestItems(warmW)

    // Author reload: alice compacted her storage while typing.
    await alice.shutdown()
    const alice2 = await world.client("alice-reloaded", alice.storage)
    const authorMark = alice2.meter.mark()
    const reopened = await alice2.repo.find<TextDoc>(handle.url)
    await settle()
    expect(reopened.doc().text).toBe(typed(N).text)
    const authorW = alice2.meter.since(authorMark)
    m.authorReloadDownBytes = authorW.bytes("down")
    m.authorReloadLooseCommits = coveredLooseInResponses(
      authorW,
      typed(N)
    ).loose
  }, 60_000)

  afterAll(() => {
    report("typed", m)
    return world.close()
  })

  // Ideal: the upload is the document plus per-item signing overhead.
  it("budget: bytes and rounds uploaded while typing", () => {
    budget.check("typed.push.upBytesPerSaveByte", m.pushUpBytes / saveSize(N), {
      tolerance: 0.005,
    })
    budget.check("typed.push.rounds", m.pushRounds)
    // C1: every round re-sends a fingerprint per item of history, so this
    // grows with the square of the number of typing steps.
    budget.check("typed.push.requestItems", m.pushRequestItems)
  })

  // Ideal (C7): each commit goes up exactly once.
  it("each loose commit is uploaded once (C7; in-process server)", () => {
    expect(m.pushDistinctLooseCommits).toBeGreaterThan(0)
    expect(m.pushLooseCommitFrames).toBe(m.pushDistinctLooseCommits)
  })

  it("budget: HeadsUpdate acks while typing (C6)", () => {
    budget.check("typed.push.headsUpdates", m.pushHeadsUpdates)
    budget.check(
      "typed.push.headsUpdateEnvelopeBytes",
      m.pushHeadsUpdateEnvelopeBytes
    )
    // Each ack lists the server's heads at that moment, which depends on
    // the order it ingests a typing step's burst; runs vary by ±4%.
    budget.check("typed.push.headsUpdateHeads", m.pushHeadsUpdateHeads, {
      tolerance: 0.08,
    })
  })

  it("budget: loose commits the server keeps", () => {
    budget.check("typed.server.looseCommits", m.serverLooseCommits)
    budget.check(
      "typed.server.coveredLooseCommits",
      m.serverCoveredLooseCommits
    )
  })

  // Ideal (C2): once a fragment covers a range, the server's minimized
  // tree drops the loose commits inside it.
  it.fails("target: server prunes loose commits covered by a fragment (C2)", () => {
    expect(m.serverCoveredLooseCommits).toBe(0)
  })

  it("budget: cold fetch bytes", () => {
    budget.check(
      "typed.fetch.downBytesPerSaveByte",
      m.fetchDownBytes / saveSize(N),
      { tolerance: 0.005 }
    )
    budget.check("typed.fetch.looseCommits", m.fetchLooseCommits)
    budget.check("typed.fetch.coveredLooseCommits", m.fetchCoveredLooseCommits)
    // Signed envelope per loose commit (C5), excluding the change itself.
    budget.check(
      "typed.fetch.envelopeBytesPerLooseCommit",
      m.fetchEnvelopeBytesPerLooseCommit
    )
  })

  // Ideal (C2): a response never ships a loose commit alongside a
  // fragment that already contains it.
  it.fails("target: cold fetch ships no loose commit covered by a fragment (C2)", () => {
    expect(m.fetchCoveredLooseCommits).toBe(0)
  })

  // Ideal (C2 + C5): a cold fetch costs about what the document costs to
  // store: compressed fragments plus the uncovered tail, without a signed
  // envelope per keystroke. 4× leaves room for signatures and framing.
  it.fails("target: cold fetch is within 4x of the saved document (C2/C5)", () => {
    expect(m.fetchDownBytes).toBeLessThanOrEqual(4 * saveSize(N))
  })

  it("budget: rounds per find", () => {
    budget.check("typed.fetch.rounds", m.fetchRounds)
  })

  // Opening a document is one round trip: loading what the round fetched
  // stores nothing new, so it does not arm a second one (C3).
  it("one sync round per find (C3)", () => {
    expect(m.fetchRounds).toBe(1)
  })

  // One round: before the C3 fix, loading the fetched data re-armed a
  // second, identical one.
  it("budget: reader reload of an unchanged doc", () => {
    budget.check("typed.readerReload.bytes", m.readerReloadBytes, {
      tolerance: 0.005,
    })
    budget.check("typed.readerReload.rounds", m.readerReloadRounds)
    budget.check("typed.readerReload.requestItems", m.readerReloadRequestItems)
  })

  // Ideal (C1): when nothing changed, confirming that costs O(heads),
  // not a fingerprint per item of history.
  it.fails("target: reader reload of an unchanged doc costs O(heads) (C1)", () => {
    expect(m.readerReloadBytes).toBeLessThanOrEqual(512)
  })

  it("budget: author reload after compaction", () => {
    budget.check("typed.authorReload.downBytes", m.authorReloadDownBytes, {
      tolerance: 0.005,
    })
    budget.check("typed.authorReload.looseCommits", m.authorReloadLooseCommits)
  })

  // Ideal (C4): the author already has the whole document, so reopening
  // it downloads no commits, including the ones compaction removed from
  // local storage because a fragment now covers them.
  it.fails("target: author reload downloads no commits (C4)", () => {
    expect(m.authorReloadLooseCommits).toBe(0)
  })
})

// ── Bulk import ───────────────────────────────────────────────────────

describe("Sync throughput: bulk import of a 1000-change document", () => {
  const N = 1000
  const world = new World()
  const m: Record<string, number> = {}

  beforeAll(async () => {
    await world.start()
    const alice = await world.client("alice")
    const mark = alice.meter.mark()
    const handle = importDoc(alice.repo, N)
    await settle()
    const w = alice.meter.since(mark)
    const held = await serverHoldings(world.server, handle.documentId, typed(N))
    // Complete before measured: an upload that stopped early looks cheaper.
    expect(held.missing).toBe(0)
    const ids = uploadedCommitIds(w)
    const acks = headsUpdates(w)
    m.upBytes = w.bytes("up")
    m.looseCommitFrames = ids.length
    m.distinctLooseCommits = new Set(ids).size
    m.headsUpdates = acks.acks
    m.headsUpdateHeads = acks.heads
    m.headsUpdateEnvelopeBytes = acks.envelopeBytesPerAck
    m.rounds = w.count("up", "BatchSyncRequest")
  }, 30_000)

  afterAll(() => {
    report("import", m)
    return world.close()
  })

  it("budget: upload", () => {
    // Varies by ±0.1% run to run (100,002–100,109 B): which commits a
    // second round still has to fingerprint depends on ingest timing.
    budget.check("import.push.upBytesPerSaveByte", m.upBytes / saveSize(N), {
      tolerance: 0.01,
    })
    budget.check("import.push.rounds", m.rounds)
  })

  // Ideal (C3b): one round uploads everything. The second round comes from
  // the save that `#doSync` itself flushed before the first round, which
  // re-arms it (the C3 fix leaves this at 2).
  it.fails("target: a bulk import is one sync round (C3b)", () => {
    expect(m.rounds).toBe(1)
  })

  it("each loose commit is uploaded once (C7; in-process server)", () => {
    expect(m.distinctLooseCommits).toBeGreaterThan(0)
    expect(m.looseCommitFrames).toBe(m.distinctLooseCommits)
  })

  it("budget: HeadsUpdate acks (C6)", () => {
    budget.check("import.push.headsUpdates", m.headsUpdates)
    budget.check(
      "import.push.headsUpdateEnvelopeBytes",
      m.headsUpdateEnvelopeBytes
    )
    // Each ack lists the server's heads at that moment, which depends on
    // the order it ingests the burst; runs vary by about ±9%.
    budget.check("import.push.headsUpdateHeads", m.headsUpdateHeads, {
      tolerance: 0.15,
    })
  })

  // Ideal (C6): heads are acknowledged once per round, not once per
  // ingested item with the whole head list each time.
  it.fails("target: at most one HeadsUpdate per sync round (C6)", () => {
    expect(m.headsUpdates).toBeLessThanOrEqual(m.rounds)
  })
})

// ── Overlapping rounds ────────────────────────────────────────────────

describe("Sync throughput: typing while a sync round is in flight", () => {
  const N = 1000
  const STEP = 25
  const world = new World()
  const m: Record<string, number> = {}

  beforeAll(async () => {
    await world.start()
    const alice = await world.client("alice")
    const changes = changesOf(N)
    const first = A.applyChanges(A.init<TextDoc>(), changes.slice(0, 1))[0]
    const mark = alice.meter.mark()
    const handle = alice.repo.import<TextDoc>(A.save(first), {
      docId: nextDocId(),
    })
    // Unlike typeDoc, don't wait for each step to sync: steps land one
    // macrotask apart, so saves and rounds overlap. Ordered by the event
    // loop rather than the clock, this reproduces C7 on every run. The
    // overlapping rounds are C3b's re-arms: with C3b fixed this is 2
    // rounds and no duplicates.
    for (let i = 1; i < N; i += STEP) {
      handle.update(d => A.applyChanges(d, changes.slice(i, i + STEP))[0])
      await wait(0)
    }
    await settle()
    const w = alice.meter.since(mark)
    const held = await serverHoldings(world.server, handle.documentId, typed(N))
    expect(held.missing).toBe(0)
    const ids = uploadedCommitIds(w)
    m.looseCommitFrames = ids.length
    m.distinctLooseCommits = new Set(ids).size
    m.duplicateUploads = ids.length - new Set(ids).size
    m.rounds = w.count("up", "BatchSyncRequest")
  }, 30_000)

  afterAll(() => {
    report("overlap", m)
    return world.close()
  })

  it("budget: duplicate uploads and rounds (C7)", () => {
    expect(m.distinctLooseCommits).toBeGreaterThan(0)
    // 13–15 duplicates (and 943 or 968 distinct commits) across 24 runs,
    // 3 in parallel: which commits two rounds race on shifts slightly.
    budget.check("overlap.duplicateLooseCommitUploads", m.duplicateUploads, {
      slack: 3,
    })
    budget.check("overlap.rounds", m.rounds, { slack: 2 })
  })

  // Ideal (C7): a commit already uploaded by an earlier round, or by an
  // overlapping one, is not uploaded again.
  it.fails("target: each loose commit is uploaded once across overlapping rounds (C7)", () => {
    expect(m.looseCommitFrames).toBe(m.distinctLooseCommits)
  })
})

// ── Live editing ──────────────────────────────────────────────────────

describe("Sync throughput: live edits", () => {
  const world = new World()
  const m: Record<string, number> = {}
  const K = 3
  const BURST = 10

  beforeAll(async () => {
    const timers = timerMark()
    await world.start()
    const alice = await world.client("alice")
    const sub = await world.client("subscriber")

    // One keystroke at history N and 10N.
    for (const n of [100, 1000]) {
      const handle = await typeDoc(alice.repo, n)
      const mark = alice.meter.mark()
      const changeBytes = typeOneMore(handle, n)
      await settle()
      const w = alice.meter.since(mark)
      const held = await serverHoldings(
        world.server,
        handle.documentId,
        typed(n + 1)
      )
      // Complete before measured: the keystroke reached the server.
      expect(held.missing).toBe(0)
      expect(w.bytes("up")).toBeGreaterThan(changeBytes)
      m[`change${n}Bytes`] = changeBytes
      m[`change${n}UpBytes`] = w.bytes("up")
      m[`change${n}Rounds`] = w.count("up", "BatchSyncRequest")
      m[`change${n}RequestItems`] = requestItems(w)
    }

    // A burst of keystrokes, each its own handle.update, closer together
    // than the save throttle.
    {
      const N = 100
      const handle = importDoc(alice.repo, N)
      await settle()
      const mark = alice.meter.mark()
      const start = Date.now()
      for (let k = 0; k < BURST; k++) {
        if (k > 0) await wait(SAVE_THROTTLE_MS / 10)
        typeOneMore(handle, N + k)
      }
      m.burstElapsedMs = Date.now() - start
      await settle()
      const held = await serverHoldings(
        world.server,
        handle.documentId,
        typed(N + BURST)
      )
      expect(held.missing).toBe(0)
      m.burstRounds = alice.meter.since(mark).count("up", "BatchSyncRequest")
    }

    // A subscriber watching K keystrokes arrive.
    const N = 100
    const handle = importDoc(alice.repo, N)
    await settle()
    const watched = await sub.repo.find<TextDoc>(handle.url)
    await settle()
    const mark = sub.meter.mark()
    for (let k = 0; k < K; k++) {
      typeOneMore(handle, N + k)
      const expected = typed(N + k + 1).text
      await awaitDoc(watched, h => h.doc()?.text === expected, {
        timeout: 5000,
      })
      await settle()
    }
    const w = sub.meter.since(mark)
    m.subscriberUpBytes = w.bytes("up")
    m.subscriberRounds = w.count("up", "BatchSyncRequest")
    m.subscriberDownLooseCommits = w.count("down", "LooseCommit")

    // Idle with everything open. Any periodic work (heartbeat, poll,
    // retry) is a pending timer or a live interval, whatever its period.
    await settle()
    const pending = pendingTimeouts(timers)
    m.idleShortTimeouts = pending.filter(t => t.delay <= 10_000).length
    m.idleLongTimeouts = pending.length - m.idleShortTimeouts
    m.idleIntervals = activeIntervals(timers).length
    m.roundsSoFar = [alice, sub].reduce(
      (n, c) => n + c.meter.since().count("up", "BatchSyncRequest"),
      0
    )
    const marks = [alice.meter, sub.meter, world.server.meter].map(meter => ({
      meter,
      mark: meter.mark(),
    }))
    await wait(1000)
    m.idleFrames = marks.reduce((n, x) => n + x.meter.since(x.mark).total, 0)
  }, 60_000)

  afterAll(() => {
    report("live", m)
    return world.close()
  })

  it("budget: one keystroke at 100 and 1000 changes of history", () => {
    budget.check("live.change100.upBytes", m.change100UpBytes, {
      tolerance: 0.005,
    })
    budget.check("live.change1000.upBytes", m.change1000UpBytes, {
      tolerance: 0.005,
    })
    budget.check("live.change100.rounds", m.change100Rounds)
    budget.check("live.change1000.rounds", m.change1000Rounds)
    budget.check("live.change100.requestItems", m.change100RequestItems)
    budget.check("live.change1000.requestItems", m.change1000RequestItems)
  })

  // Ideal (C1): a keystroke costs the same whether the doc has 100 or
  // 1000 changes of history — the change plus O(heads) of framing.
  it.fails("target: per-keystroke upload does not grow with history (C1)", () => {
    expect(m.change1000UpBytes / m.change100UpBytes).toBeLessThanOrEqual(1.5)
  })

  // Ideal (C1): pushing one new commit needs at most the heads it builds
  // on, not a fingerprint of every item in the sedimentree.
  it.fails("target: a keystroke's sync request is O(heads), not O(history) (C1)", () => {
    expect(m.change1000RequestItems).toBeLessThanOrEqual(8)
  })

  // Ideal: the 100 ms save throttle coalesces a burst, so a burst costs at
  // most one round per throttle window it spans plus the leading one, not
  // one per keystroke. Measured over 40 bursts: 39 hit exactly that, one
  // took one more, because `#doSync` flushes a pending save early and that
  // save re-arms the round (C3b), which can chain. The bound allows two
  // more; without the throttle every burst is 10 rounds. It is computed
  // from the burst's actual duration, so a slow machine loosens it instead
  // of failing. Not budgeted: how a burst falls into windows is timing.
  it("a burst of keystrokes is coalesced by the save throttle", () => {
    expect(m.burstRounds).toBeGreaterThan(0)
    expect(m.burstRounds).toBeLessThanOrEqual(
      Math.ceil(m.burstElapsedMs / SAVE_THROTTLE_MS) + 1 + 2
    )
  })

  it("budget: what a subscriber sends per received change", () => {
    budget.check("live.subscriber.upBytesPerChange", m.subscriberUpBytes / K, {
      tolerance: 0.005,
    })
    budget.check("live.subscriber.roundsPerChange", m.subscriberRounds / K)
  })

  it("a subscriber receives each pushed change exactly once", () => {
    expect(m.subscriberDownLooseCommits).toBe(K)
  })

  // Receiving a change needs at most an ack (a HeadsUpdate), never a full
  // sync round of the receiver's own (C3).
  it("a subscriber opens no sync round per received change (C3)", () => {
    expect(m.subscriberRounds).toBe(0)
  })

  // Nothing changes, nothing is sent, and nothing is scheduled to. The
  // wasm side leaves each completed round's 60 s timeout pending (it fires
  // later and sends nothing), so long timeouts are allowed up to one per
  // round; a heartbeat or poll of any period would exceed that.
  it("idle with documents open sends nothing and schedules nothing", () => {
    expect(m.idleFrames).toBe(0)
    expect(m.idleIntervals).toBe(0)
    expect(m.idleShortTimeouts).toBe(0)
    expect(m.idleLongTimeouts).toBeLessThanOrEqual(m.roundsSoFar)
  })
})

// ── Reconnect ─────────────────────────────────────────────────────────

describe("Sync throughput: reconnect", () => {
  const world = new World()
  const m: Record<string, number> = {}
  const DOCS = 4

  beforeAll(async () => {
    await world.start()
    const alice = await world.client("alice")
    for (let i = 0; i < DOCS; i++) importDoc(alice.repo, 100)
    await settle()
    const mark = alice.meter.mark()
    await alice.endpoint.dropConnection()
    // The reconnect backoff is a pending timer, so settle() waits through
    // it, the redial and the re-subscribe rounds.
    await settle()
    await awaitSubductionConnected(alice.repo, { timeout: 5000 })
    await settle()
    const w = alice.meter.since(mark)
    m.connections = alice.endpoint.connections
    m.rounds = w.count("up", "BatchSyncRequest")
    m.requestBytes = w.bytes("up", "BatchSyncRequest")
    m.requestItems = requestItems(w)
  }, 30_000)

  afterAll(() => {
    report("reconnect", m)
    return world.close()
  })

  // Ideal: one round per attached doc to re-subscribe, no more.
  it("one sync round per attached document", () => {
    expect(m.connections).toBe(2)
    expect(m.rounds).toBe(DOCS)
  })

  it("budget: re-subscribe request per document", () => {
    budget.check("reconnect.requestBytesPerDoc", m.requestBytes / DOCS)
    budget.check("reconnect.requestItemsPerDoc", m.requestItems / DOCS)
  })

  // Ideal (C1): re-subscribing to a doc that did not change while
  // offline costs O(heads), not a fingerprint per item of history (these
  // docs have 100 changes and one head).
  it.fails("target: re-subscribe request is O(heads) per document (C1)", () => {
    expect(m.requestBytes / DOCS).toBeLessThanOrEqual(256)
  })
})

// ── Tab ↔ worker hop ──────────────────────────────────────────────────

describe("Sync throughput: tab → worker MessagePort", () => {
  const world = new World()
  const m: Record<string, number> = {}

  beforeAll(async () => {
    await world.start()
    const channel = new MessageChannel()
    const port = new WireMeter("port")
    meterMessagePort(channel.port1, port)
    meterMessagePort(channel.port2, port)
    const endpoint = new MeteredEndpoint(world.server.url, "worker")
    const worker = new Repo({
      peerId: "worker" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [new MessageChannelNetworkAdapter(channel.port1)],
      sharePolicy: async () => true,
      subductionWebsocketEndpoints: [endpoint],
    })
    const tab = new Repo({
      peerId: "tab" as PeerId,
      network: [new MessageChannelNetworkAdapter(channel.port2)],
      sharePolicy: async () => true,
    })
    world.onClose(() => channel.port1.close())
    world.onClose(() => worker.shutdown())
    world.onClose(() => tab.shutdown())
    await awaitSubductionConnected(worker, { timeout: 5000 })

    for (const n of [100, 1000]) {
      const handle = importDoc(tab, n)
      await settle()
      const mark = port.mark()
      const changeBytes = typeOneMore(handle, n)
      await settle()
      const w = port.since(mark)
      m[`bytesPerChangeByte${n}`] = w.bytes("up") / changeBytes
      m[`messages${n}`] = w.count("up")
    }
  }, 30_000)

  afterAll(() => {
    report("port", m)
    return world.close()
  })

  // The automerge sync protocol on the local hop is incremental: one
  // keystroke costs a small multiple of the change, regardless of history.
  it("a keystroke costs a small multiple of the change, independent of history", () => {
    expect(m.messages100).toBeGreaterThan(0)
    expect(m.bytesPerChangeByte100).toBeLessThanOrEqual(4)
    expect(m.bytesPerChangeByte1000).toBeLessThanOrEqual(4)
    expect(
      m.bytesPerChangeByte1000 / m.bytesPerChangeByte100
    ).toBeLessThanOrEqual(1.5)
  })
})
