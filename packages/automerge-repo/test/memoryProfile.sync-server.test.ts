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
 *
 * A second, separately gated phase measures active editing instead of idle
 * memory; see "sync-server active-editing profile" below.
 */
import * as fs from "node:fs"
import { describe, it } from "vitest"
import { Repo } from "../src/Repo.js"
import type { DocHandle } from "../src/DocHandle.js"
import type { AutomergeUrl, Message, PeerId } from "../src/index.js"
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

/**
 * Active-editing phase: how often a sync server reloads documents that a
 * client keeps editing in bursts separated by pauses, and what that costs.
 *
 *   ACTIVE_PROFILE=/tmp/active.json ACTIVE_RELEASE_MS=30000 \
 *     ACTIVE_PAUSE_MS=1000 NODE_OPTIONS=--expose-gc npx vitest run \
 *     --project @automerge/automerge-repo \
 *     packages/automerge-repo/test/memoryProfile.sync-server.test.ts
 *
 * One persistent client edits ACTIVE_DOCS documents in each burst, then
 * pauses. The server has storage and an announce-nothing share policy and
 * never touches a document itself. With ACTIVE_GC=forced (the default) GC
 * is forced at the end of every pause, the worst case for reloads; with
 * ACTIVE_GC=natural it is left to the engine. Reloads are counted with the
 * `doc-loaded` doc-metric. ACTIVE_RELEASE_MS sets releaseUnobservedAfterMs
 * (a number or `Infinity`; unset uses the default, and refs without the
 * option ignore it).
 */
const ACTIVE_OUT = process.env.ACTIVE_PROFILE

describe.runIf(ACTIVE_OUT)("sync-server active-editing profile", () => {
  const env = (name: string, fallback: number) => {
    const value = process.env[name]
    return value === undefined || value === "" ? fallback : Number(value)
  }
  const releaseEnv = process.env.ACTIVE_RELEASE_MS
  const RELEASE_MS =
    releaseEnv === undefined || releaseEnv === ""
      ? undefined
      : Number(releaseEnv)
  const PAUSE_MS = env("ACTIVE_PAUSE_MS", 1000)
  const BURSTS = env("ACTIVE_BURSTS", 8)
  const DOCS = env("ACTIVE_DOCS", 20)
  const HISTORY = env("ACTIVE_HISTORY", 200)
  const CHANGES_PER_BURST = env("ACTIVE_CHANGES_PER_BURST", 5)
  const FORCED_GC = (process.env.ACTIVE_GC ?? "forced") === "forced"

  it("samples reloads and memory across editing bursts", async () => {
    const server = new Repo({
      peerId: "server" as PeerId,
      storage: new DummyStorageAdapter(),
      sharePolicy: async () => false,
      ...(RELEASE_MS === undefined
        ? {}
        : { releaseUnobservedAfterMs: RELEASE_MS }),
    })
    const client = new Repo({
      peerId: "client" as PeerId,
      storage: new DummyStorageAdapter(),
    })

    let reloads = 0
    server.on("doc-metrics", event => {
      if (event.type === "doc-loaded") reloads++
    })
    let majorGCs = 0
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        // NODE_PERFORMANCE_GC_MAJOR
        if ((entry as any).detail?.kind === 4) majorGCs++
      }
    })
    observer.observe({ entryTypes: ["gc"] })

    // Connect with real peer metadata so each side keeps the other's sync
    // state, and count the sync bytes the client sends.
    let bytesToServer = 0
    let toClient!: DummyNetworkAdapter
    const toServer: DummyNetworkAdapter = new DummyNetworkAdapter({
      startReady: true,
      sendMessage: (message: Message) => {
        if ("data" in message && message.data) {
          bytesToServer += message.data.byteLength
        }
        setImmediate(() => toClient.receive(message))
      },
    })
    toClient = new DummyNetworkAdapter({
      startReady: true,
      sendMessage: (message: Message) =>
        setImmediate(() => toServer.receive(message)),
    })
    // Adapters drop messages until the repo connects them, which waits for
    // its storage id.
    const connected = [toServer, toClient].map(
      adapter =>
        new Promise<void>(resolve => {
          const connect = adapter.connect.bind(adapter)
          adapter.connect = (peerId: PeerId) => {
            connect(peerId)
            resolve()
          }
        })
    )
    client.networkSubsystem.addNetworkAdapter(toServer)
    server.networkSubsystem.addNetworkAdapter(toClient)
    await Promise.all(connected)
    const serverStorageId = (await server.storageId())!
    const clientStorageId = await client.storageId()
    toServer.emit("peer-candidate", {
      peerId: server.peerId,
      peerMetadata: { storageId: serverStorageId, isEphemeral: false },
    })
    toClient.emit("peer-candidate", {
      peerId: client.peerId,
      peerMetadata: { storageId: clientStorageId, isEphemeral: false },
    })

    // The server has acknowledged every client document at its heads.
    const sorted = (heads: readonly string[]) => [...heads].sort().join(",")
    const converged = (handles: DocHandle<SyncDoc>[]) => () =>
      handles.every(handle => {
        const info = handle.getSyncInfo(serverStorageId)
        return (
          info !== undefined &&
          sorted(info.lastHeads) === sorted(handle.heads())
        )
      })

    const handles: DocHandle<SyncDoc>[] = []
    for (let d = 0; d < DOCS; d++) {
      const handle = client.create<SyncDoc>({ log: [] })
      for (let c = 0; c < HISTORY; c++) {
        handle.change(doc => {
          doc.log.push(`doc ${d} history ${c} ${PAYLOAD}`)
        })
      }
      handles.push(handle)
    }
    await until(converged(handles), "initial sync")
    await server.flush()
    await settleAndGC()

    const bursts: Array<Record<string, number>> = []
    for (let burst = 0; burst < BURSTS; burst++) {
      const reloadsBefore = reloads
      const bytesBefore = bytesToServer
      const gcsBefore = majorGCs
      const start = performance.now()
      for (const handle of handles) {
        for (let c = 0; c < CHANGES_PER_BURST; c++) {
          handle.change(doc => {
            doc.log.push(`burst ${burst} change ${c} ${PAYLOAD}`)
          })
        }
      }
      await until(converged(handles), `burst ${burst} to sync`)
      const syncMs = performance.now() - start

      // The idle time between bursts is what this phase measures, so it is a
      // real wall-clock wait.
      await pause(PAUSE_MS)
      if (FORCED_GC) {
        for (let i = 0; i < GC_PASSES_PER_SAMPLE; i++) {
          globalThis.gc?.()
          await yieldMacrotask()
        }
      }

      bursts.push({
        burst,
        reloads: reloads - reloadsBefore,
        bytesToServer: bytesToServer - bytesBefore,
        syncMs: Math.round(syncMs),
        majorGCs: majorGCs - gcsBefore,
        residentDocs: Object.keys(server.handles).length,
        heapUsedMB: toMB(process.memoryUsage().heapUsed),
      })
    }
    observer.disconnect()

    const total = (key: string) =>
      bursts.reduce((sum, sample) => sum + sample[key], 0)
    fs.writeFileSync(
      ACTIVE_OUT!,
      JSON.stringify(
        {
          meta: {
            releaseUnobservedAfterMs: RELEASE_MS ?? "default",
            pauseMs: PAUSE_MS,
            bursts: BURSTS,
            docs: DOCS,
            history: HISTORY,
            changesPerBurst: CHANGES_PER_BURST,
            gc: FORCED_GC ? "forced" : "natural",
          },
          summary: {
            reloadsPerBurst: total("reloads") / BURSTS,
            bytesToServerPerBurst: Math.round(total("bytesToServer") / BURSTS),
            syncMsPerBurst: Math.round(total("syncMs") / BURSTS),
            finalResidentDocs: bursts[bursts.length - 1].residentDocs,
            finalHeapUsedMB: bursts[bursts.length - 1].heapUsedMB,
          },
          bursts,
        },
        null,
        2
      )
    )
    await client.shutdown()
    await server.shutdown()
  }, 600_000)
})
