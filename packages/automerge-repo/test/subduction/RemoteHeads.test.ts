/**
 * A subduction peer's heads should surface on the local DocHandle (via the
 * `remote-heads` event and `getSyncInfo`), and the last-known heads should
 * persist so they survive a reload with no network re-sync.
 */
import { next as A } from "@automerge/automerge"
import { beforeAll, afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"

import { WebSocketClientAdapter } from "../../../automerge-repo-network-websocket/src/WebSocketClientAdapter.js"
import { WebSocketServerAdapter } from "../../../automerge-repo-network-websocket/src/WebSocketServerAdapter.js"
import { Repo } from "../../src/Repo.js"
import { encodeHeads } from "../../src/AutomergeUrl.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../../src/initSubduction.js"
import { pause } from "../../src/helpers/pause.js"
import type { PeerId, UrlHeads } from "../../src/types.js"

beforeAll(async () => {
  await initSubduction()
})

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")

const headsOf = (handle: { doc(): unknown }): UrlHeads =>
  encodeHeads(A.getHeads(handle.doc() as A.Doc<unknown>))

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await pause(intervalMs)
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

describe("subduction remote-heads forwarding", () => {
  const cleanups: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const c of cleanups.reverse()) await c()
    cleanups.length = 0
  })

  async function startServer() {
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>(r => wss.on("listening", r))
    const addr = wss.address()
    if (typeof addr === "string") throw new Error("bad address")
    const port = addr.port
    const serverAdapter = new WebSocketServerAdapter(wss)
    const repo = new Repo({
      peerId: `server-${port}` as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      subductionAdapters: [
        { adapter: serverAdapter, serviceName: `localhost:${port}`, role: "accept" },
      ],
      sharePolicy: async () => true,
    })
    cleanups.push(async () => {
      serverAdapter.disconnect()
      await new Promise<void>((res, rej) => wss.close(e => (e ? rej(e) : res())))
    })
    return { repo, url: `ws://localhost:${port}` }
  }

  function startClient(
    name: string,
    url: string,
    storage: DummyStorageAdapter = new DummyStorageAdapter()
  ) {
    const adapter = new WebSocketClientAdapter(url)
    const repo = new Repo({
      peerId: `${name}-${Math.random().toString(36).slice(2, 7)}` as PeerId,
      storage,
      network: [],
      subductionAdapters: [{ adapter, serviceName: new URL(url).host }],
      sharePolicy: async () => true,
    })
    cleanups.push(() => adapter.disconnect())
    return { repo, adapter, storage }
  }

  it("a peer's heads surface on the DocHandle (remote-heads + getSyncInfo)", async () => {
    const server = await startServer()
    const alice = startClient("alice", server.url)
    const bob = startClient("bob", server.url)

    const aliceHandle = alice.repo.create<{ alice: string; bob?: string }>()
    aliceHandle.change(d => {
      d.alice = "a"
    })

    const events: Array<{ storageId: string; heads: UrlHeads; timestamp: number }> =
      []
    aliceHandle.on("remote-heads", e =>
      events.push({ storageId: e.storageId, heads: e.heads, timestamp: e.timestamp })
    )

    // Bob finds the doc, then makes a change. That change propagates
    // bob → server → alice; the server's heads change, and alice (subscribed)
    // is notified via subduction's onRemoteHeads.
    const bobHandle = await bob.repo.find<{ alice: string; bob?: string }>(
      aliceHandle.url
    )
    expect(bobHandle.doc()!.alice).toBe("a")
    bobHandle.change(d => {
      d.bob = "b"
    })

    // Bidirectional sync lands bob's change on alice.
    await waitFor(() => aliceHandle.doc()?.bob === "b", 8000)

    // Alice eventually receives a remote-heads event whose heads equal her
    // (now fully-synced) doc heads.
    await waitFor(() => {
      const want = headsOf(aliceHandle)
      return events.some(e => sameSet(e.heads, want))
    }, 8000)

    const want = headsOf(aliceHandle)
    const match = events.find(e => sameSet(e.heads, want))!
    expect(match).toBeDefined()

    // Heads are bs58check UrlHeads (not raw subduction hex) — equal to the
    // doc's own encoded heads.
    expect(sameSet(match.heads, want)).toBe(true)

    // And visible via getSyncInfo for that peer's storage id.
    const info = aliceHandle.getSyncInfo(match.storageId as any)
    expect(info).toBeDefined()
    expect(sameSet(info!.lastHeads, want)).toBe(true)
  }, 20_000)

  it("last-known remote heads persist and replay on a fresh Repo (reload)", async () => {
    const server = await startServer()
    const aliceStorage = new DummyStorageAdapter()
    const alice = startClient("alice", server.url, aliceStorage)
    const bob = startClient("bob", server.url)

    const aliceHandle = alice.repo.create<{ alice: string; bob?: string }>()
    aliceHandle.change(d => {
      d.alice = "a"
    })
    const url = aliceHandle.url

    let captured: { storageId: string; heads: UrlHeads } | undefined
    aliceHandle.on("remote-heads", e => {
      captured = { storageId: e.storageId, heads: e.heads }
    })

    const bobHandle = await bob.repo.find<{ alice: string; bob?: string }>(url)
    bobHandle.change(d => {
      d.bob = "b"
    })
    await waitFor(() => aliceHandle.doc()?.bob === "b", 8000)
    await waitFor(() => captured !== undefined, 8000)
    // Let the fire-and-forget saveRemoteHeads land in the shared adapter.
    await pause(300)

    const expected = captured!

    // Fresh Repo over the SAME storage, with NO network — so any remote
    // heads it shows can only come from the persisted replay, not a re-sync.
    const reloaded = new Repo({
      peerId: "alice-reload" as PeerId,
      storage: aliceStorage,
      network: [],
    })
    cleanups.push(async () => {
      await reloaded.shutdown()
    })

    const handle = await reloaded.find(url)

    await waitFor(
      () => handle.getSyncInfo(expected.storageId as any) !== undefined,
      8000
    )
    const info = handle.getSyncInfo(expected.storageId as any)!
    expect(sameSet(info.lastHeads, expected.heads)).toBe(true)
  }, 20_000)
})
