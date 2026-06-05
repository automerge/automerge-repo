import { describe, it, expect, afterEach } from "vitest"
import { once } from "events"
import { WebSocketServer } from "ws"

import {
  Subduction,
  MemorySigner,
  MemoryStorage,
} from "@automerge/automerge-subduction"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { type PeerId } from "../../src/types.js"
import { toSedimentreeId } from "../../src/subduction/helpers.js"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import { pause } from "../../src/helpers/pause.js"

/**
 * A bare-subduction WebSocket endpoint. Lets the test control exactly when
 * the endpoint holds a document, so we can model a relay/worker that is a
 * connected, subscribed sync peer but does not (yet) have the data a
 * downstream client is asking for.
 */
async function startEndpoint(): Promise<{
  url: string
  subduction: Subduction
  close: () => Promise<void>
}> {
  const signer = new MemorySigner()
  const storage = new MemoryStorage()
  const subduction = new Subduction(signer, storage)

  const wss = new WebSocketServer({ port: 0 })
  await once(wss, "listening")
  const address = wss.address()
  if (typeof address === "string") throw new Error("unexpected address type")
  const url = `ws://localhost:${address.port}`
  const serviceName = `localhost:${address.port}`

  wss.on("connection", ws => {
    const transport = new WebSocketTransport(ws as any)
    subduction
      .acceptTransport(transport, serviceName)
      .catch(e => console.error("acceptTransport failed:", e))
  })

  return {
    url,
    subduction,
    async close() {
      await subduction.disconnectAll()
      await new Promise<void>((resolve, reject) =>
        wss.close(err => (err ? reject(err) : resolve()))
      )
    },
  }
}

function createClientRepo(
  peerId: string,
  serverUrl: string,
  unavailableGraceMs?: number
): Repo {
  return new Repo({
    peerId: peerId as PeerId,
    storage: new DummyStorageAdapter(),
    subductionWebsocketEndpoints: [serverUrl],
    subductionTimeouts:
      unavailableGraceMs === undefined ? undefined : { unavailableGraceMs },
  })
}

describe("find() availability race against a connected peer", () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    cleanups.length = 0
  })

  // Reproduces the reported bug: "do repo.find, and it returns as
  // unavailable in <30ms. Doesn't happen every time, but does frequently."
  //
  // The consumer is connected to a peer (here a bare endpoint standing in
  // for a relay/worker) that does NOT have the requested document. A
  // connected, subscribed peer that lacks the doc *right now* may still be
  // about to deliver it (it could be fetching from upstream). The query
  // must NOT flip to `unavailable` almost instantly — it must stay
  // `loading` for at least the grace window.
  //
  // Before the fix the query went `loading -> unavailable` within a few
  // milliseconds of the first (successful but empty) sync round.
  it("stays loading, not instantly unavailable, against a connected empty peer", async () => {
    const GRACE_MS = 1_000
    const relay = await startEndpoint()
    cleanups.push(() => relay.close())

    // The doc exists *somewhere* (we fabricate a valid URL via a throwaway
    // repo) but the relay the consumer talks to does not have it.
    const ghostRepo = createClientRepo("ghost", relay.url)
    const ghost = ghostRepo.create<{ value: number }>()
    const url = ghost.url
    // Do not let the ghost push to the relay: shut it down before its
    // throttled save reaches the wire, so the relay stays empty.
    await ghostRepo.shutdown()

    const consumer = createClientRepo("consumer", relay.url, GRACE_MS)
    cleanups.push(async () => consumer.shutdown())

    const progress = consumer.findWithProgress<{ value: number }>(url as any)

    // Sample the state across the first ~half of the grace window. The bug
    // would have produced `unavailable` almost immediately; the fix keeps
    // it `loading` until the grace elapses.
    const earlyStates: string[] = []
    for (let i = 0; i < 5; i++) {
      await pause(GRACE_MS / 10)
      earlyStates.push(progress.peek().state)
    }

    expect(
      earlyStates,
      `early state samples: ${earlyStates.join(", ")}`
    ).not.toContain("unavailable")
    expect(earlyStates.every(s => s === "loading")).toBe(true)
  }, 15_000)

  // The other half of the contract: a document that no connected peer has
  // must still resolve to `unavailable` once the grace window elapses,
  // rather than hanging forever.
  it("eventually reports unavailable for a doc no connected peer has", async () => {
    const GRACE_MS = 500
    const relay = await startEndpoint()
    cleanups.push(() => relay.close())

    const ghostRepo = createClientRepo("ghost", relay.url)
    const ghost = ghostRepo.create<{ value: number }>()
    const url = ghost.url
    await ghostRepo.shutdown()

    const consumer = createClientRepo("consumer", relay.url, GRACE_MS)
    cleanups.push(async () => consumer.shutdown())

    const progress = consumer.findWithProgress<{ value: number }>(url as any)

    await expect(
      progress.whenReady({ signal: AbortSignal.timeout(10_000) })
    ).rejects.toThrow(/unavailable/)
  }, 15_000)
})
