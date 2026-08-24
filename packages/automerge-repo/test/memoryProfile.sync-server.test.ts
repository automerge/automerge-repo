/**
 * Sync-server memory profile with a synthetic workload.
 *
 * Not a pass/fail test: it measures how a relay-shaped Repo's memory evolves
 * as ephemeral clients come and go, and writes per-round samples as JSON for
 * charting. Run it unchanged on two refs to compare their memory behavior:
 *
 *   MEMORY_PROFILE=/tmp/samples.json NODE_OPTIONS=--expose-gc \
 *     npx vitest run --project @automerge/automerge-repo \
 *     packages/automerge-repo/test/memoryProfile.sync-server.test.ts
 *
 * Workload, modeled on a sync server: the server Repo has storage and an
 * announce-nothing share policy, and never touches a document itself. Each
 * round, a fresh ephemeral client connects, creates documents, makes changes,
 * revisits documents from earlier rounds, then disconnects and is dropped.
 * After every round the server is flushed, timers are allowed to settle, GC
 * is forced, and memory plus live-document counts are sampled.
 *
 * Only APIs common to the compared refs are used.
 */
import * as fs from "node:fs"
import { describe, it } from "vitest"
import { Repo } from "../src/Repo.js"
import type { AutomergeUrl, PeerId } from "../src/index.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter.js"
import { pause } from "../src/helpers/pause.js"

type SyncDoc = { log: string[] }

const OUT = process.env.MEMORY_PROFILE

const ROUNDS = 24
const NEW_DOCS_PER_ROUND = 15
const CHANGES_PER_DOC = 15
const REVISITS_PER_ROUND = 10
const PAYLOAD = "x".repeat(120)

const yieldMacrotask = () => new Promise<void>(resolve => setImmediate(resolve))

async function until(cond: () => boolean, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await yieldMacrotask()
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * Wait out the storage save throttle before sampling. Longer than the Repo's
 * default 100ms saveDebounceRate so a round's writes have been issued rather
 * than still sitting in a pending throttle, which would hold the document.
 */
const SETTLE_MS = 150

/**
 * GC passes per sample. A pass is `gc()` plus a macrotask yield, so a
 * finalizer scheduled by one collection can run before the next: a
 * WeakValueMap entry is only pruned by the FinalizationRegistry callback that
 * follows its value being collected, so observing the released state can take
 * more than one pass.
 *
 * Deliberate headroom rather than a tuned threshold. Measured on both a
 * pinning and a collecting build, going from 1 pass to 10 moves the reported
 * heap by less than 0.5% and never changes the document counts, which are
 * exact either way. Six keeps samples clear of that boundary at negligible
 * cost.
 */
const GC_PASSES_PER_SAMPLE = 6

/** Let save-throttle timers fire, then force GC with macrotask yields. */
async function settleAndGC() {
  await pause(SETTLE_MS)
  for (let i = 0; i < GC_PASSES_PER_SAMPLE; i++) {
    globalThis.gc?.()
    await yieldMacrotask()
  }
}

const toMB = (bytes: number) => Math.round((bytes / 1048576) * 100) / 100

describe.runIf(OUT)("sync-server memory profile", () => {
  it("samples server memory across ephemeral client sessions", async () => {
    const storage = new DummyStorageAdapter()
    const server = new Repo({
      peerId: "server" as PeerId,
      storage,
      sharePolicy: async () => false,
    })

    const knownUrls: AutomergeUrl[] = []
    const samples: Array<Record<string, number>> = []

    const storedDocIds = () =>
      new Set(storage.keys().map(key => key.split(".")[0]))

    async function clientSession(round: number) {
      const client = new Repo({ peerId: `client-${round}` as PeerId })
      const [toServer, toClient] = DummyNetworkAdapter.createConnectedPair()
      client.networkSubsystem.addNetworkAdapter(toServer)
      server.networkSubsystem.addNetworkAdapter(toClient)
      toServer.peerCandidate("server" as PeerId)
      toClient.peerCandidate(client.peerId)
      await Promise.all([
        client.networkSubsystem.whenReady(),
        server.networkSubsystem.whenReady(),
      ])

      // New documents, each with a burst of changes.
      const created: AutomergeUrl[] = []
      for (let d = 0; d < NEW_DOCS_PER_ROUND; d++) {
        const handle = client.create<SyncDoc>({ log: [] })
        for (let c = 0; c < CHANGES_PER_DOC; c++) {
          handle.change(doc => {
            doc.log.push(`round ${round} doc ${d} change ${c} ${PAYLOAD}`)
          })
        }
        created.push(handle.url)
      }

      // Revisit recent documents from earlier rounds and edit them.
      const revisits = knownUrls.slice(-REVISITS_PER_ROUND)
      for (const url of revisits) {
        const handle = await client.find<SyncDoc>(url)
        handle.change(doc => {
          doc.log.push(`revisit in round ${round} ${PAYLOAD}`)
        })
      }
      knownUrls.push(...created)

      // The client announces its documents to the server; wait until every
      // created document has reached the server's storage.
      await until(() => {
        const stored = storedDocIds()
        return created.every(url => stored.has(url.split(":")[1]))
      }, `round ${round} documents to reach server storage`)

      toServer.disconnect()
      toClient.disconnect()
    }

    for (let round = 0; round < ROUNDS; round++) {
      await clientSession(round)
      await server.flush()
      await settleAndGC()

      const memory = process.memoryUsage()
      samples.push({
        round,
        totalDocsCreated: knownUrls.length,
        heapUsedMB: toMB(memory.heapUsed),
        rssMB: toMB(memory.rss),
        externalMB: toMB(memory.external),
        arrayBuffersMB: toMB(memory.arrayBuffers),
        serverDocsInMemory: Object.keys(server.handles).length,
        serverDocSynchronizers: Object.keys(
          server.synchronizer.docSynchronizers
        ).length,
      })
    }

    fs.writeFileSync(
      OUT!,
      JSON.stringify(
        {
          meta: {
            rounds: ROUNDS,
            newDocsPerRound: NEW_DOCS_PER_ROUND,
            changesPerDoc: CHANGES_PER_DOC,
            revisitsPerRound: REVISITS_PER_ROUND,
          },
          samples,
        },
        null,
        2
      )
    )
  }, 600_000)
})
