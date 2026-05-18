/**
 * Tests for the `subduction-peer-bound` event on `Repo`.
 *
 * The event surfaces the binding between the automerge-repo `PeerId`
 * (the self-declared label that flows through `peer-candidate` /
 * `Message.senderId`) and the subduction-level `PeerId` (the
 * cryptographically-verified Ed25519 identity returned by
 * `acceptTransport` / `connectTransport`).
 *
 * Two transport paths are exercised:
 *
 *   adapter   — `subductionAdapters` via a WebSocket adapter pair.
 *               `repoPeerId` is populated.
 *   websocket — `subductionWebsocketEndpoints` against a bare
 *               subduction WebSocket server. `repoPeerId` is absent.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { once } from "events"
import { WebSocketServer } from "ws"
import {
  MemorySigner,
  MemoryStorage,
  Subduction,
  type Policy,
} from "@automerge/automerge-subduction"
import { WebSocketClientAdapter } from "../../../automerge-repo-network-websocket/src/WebSocketClientAdapter.js"
import { WebSocketServerAdapter } from "../../../automerge-repo-network-websocket/src/WebSocketServerAdapter.js"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import { type PeerId } from "../../src/types.js"
import type { SubductionPeerBinding } from "../../src/subduction/source.js"
import { pause } from "../../src/helpers/pause.js"

async function waitForCondition(
  fn: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await pause(intervalMs)
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`)
}

// ── Adapter-path fixtures ─────────────────────────────────────────────

interface AdapterPairFixture {
  serverRepo: Repo
  serverSigner: MemorySigner
  serverPeerId: PeerId
  clientRepo: Repo
  clientSigner: MemorySigner
  clientPeerId: PeerId
  serverAdapter: WebSocketServerAdapter
  clientAdapter: WebSocketClientAdapter
  serverUrl: string
  close: () => Promise<void>
}

/**
 * Boot a server `Repo` listening on a `WebSocketServerAdapter` and a
 * client `Repo` connected via `WebSocketClientAdapter`, both wired
 * through `subductionAdapters`. Each side has an explicit
 * `MemorySigner` so tests can verify `subductionPeerId`.
 */
async function makeAdapterPair(opts?: {
  subductionPolicy?: Policy
}): Promise<AdapterPairFixture> {
  const tmp = new WebSocketServer({ port: 0 })
  await once(tmp, "listening")
  const addr = tmp.address()
  if (typeof addr === "string") throw new Error("unexpected address type")
  const port = addr.port
  await new Promise<void>((r, e) => tmp.close(err => (err ? e(err) : r())))

  const wss = new WebSocketServer({ port })
  await once(wss, "listening")

  const serviceName = `localhost:${port}`
  const serverUrl = `ws://localhost:${port}`
  const serverAdapter = new WebSocketServerAdapter(wss)

  const serverSigner = new MemorySigner()
  const clientSigner = new MemorySigner()
  const serverPeerId = "binding-server" as PeerId
  const clientPeerId = "binding-client" as PeerId

  const serverRepo = new Repo({
    peerId: serverPeerId,
    storage: new DummyStorageAdapter(),
    network: [],
    signer: serverSigner,
    subductionAdapters: [
      { adapter: serverAdapter, serviceName, role: "accept" },
    ],
    sharePolicy: async () => true,
    subductionPolicy: opts?.subductionPolicy,
  })

  const clientAdapter = new WebSocketClientAdapter(serverUrl)
  const clientRepo = new Repo({
    peerId: clientPeerId,
    storage: new DummyStorageAdapter(),
    network: [],
    signer: clientSigner,
    subductionAdapters: [{ adapter: clientAdapter, serviceName }],
    sharePolicy: async () => true,
  })

  return {
    serverRepo,
    serverSigner,
    serverPeerId,
    clientRepo,
    clientSigner,
    clientPeerId,
    serverAdapter,
    clientAdapter,
    serverUrl,
    async close() {
      try {
        clientAdapter.disconnect()
      } catch {}
      try {
        serverAdapter.disconnect()
      } catch {}
      await new Promise<void>(r => wss.close(() => r()))
    },
  }
}

// ── Websocket-path fixture ────────────────────────────────────────────

interface WebSocketServerFixture {
  url: string
  signer: MemorySigner
  subduction: Subduction
  close: () => Promise<void>
}

async function startSubductionWebsocketServer(): Promise<WebSocketServerFixture> {
  const signer = new MemorySigner()
  const storage = new MemoryStorage()
  const subduction = await Subduction.hydrate(signer, storage)

  const wss = new WebSocketServer({ port: 0 })
  await once(wss, "listening")
  const addr = wss.address()
  if (typeof addr === "string") throw new Error("unexpected address type")
  const port = addr.port
  const url = `ws://localhost:${port}`
  const serviceName = `localhost:${port}`

  wss.on("connection", ws => {
    const transport = new WebSocketTransport(ws as any)
    subduction.acceptTransport(transport, serviceName).catch(() => {})
  })

  return {
    url,
    signer,
    subduction,
    async close() {
      await subduction.disconnectAll()
      await new Promise<void>(r => wss.close(() => r()))
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Repo.on('subduction-peer-bound')", () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    cleanups.length = 0
  })

  // 1. Adapter path: callback fires with both ids, and they differ.
  it("adapter path: event fires on both peers with matching repo and subduction ids", async () => {
    const fixture = await makeAdapterPair()
    cleanups.push(() => fixture.close())

    const clientEvents: SubductionPeerBinding[] = []
    fixture.clientRepo.on("subduction-peer-bound", b => clientEvents.push(b))

    const serverEvents: SubductionPeerBinding[] = []
    fixture.serverRepo.on("subduction-peer-bound", b => serverEvents.push(b))

    await waitForCondition(
      () => clientEvents.length > 0 && serverEvents.length > 0,
      5000
    )

    expect(clientEvents).toHaveLength(1)
    expect(serverEvents).toHaveLength(1)

    const clientBinding = clientEvents[0]
    expect(clientBinding.source.kind).toBe("adapter")
    if (clientBinding.source.kind !== "adapter") {
      throw new Error("expected adapter binding")
    }
    expect(clientBinding.source.adapter).toBe(fixture.clientAdapter)
    expect(clientBinding.source.role).toBe("connect")
    expect(clientBinding.repoPeerId).toBe(fixture.serverPeerId)
    expect(clientBinding.subductionPeerId.toString()).toBe(
      fixture.serverSigner.peerId().toString()
    )

    const serverBinding = serverEvents[0]
    expect(serverBinding.source.kind).toBe("adapter")
    if (serverBinding.source.kind !== "adapter") {
      throw new Error("expected adapter binding")
    }
    expect(serverBinding.source.adapter).toBe(fixture.serverAdapter)
    expect(serverBinding.source.role).toBe("accept")
    expect(serverBinding.repoPeerId).toBe(fixture.clientPeerId)
    expect(serverBinding.subductionPeerId.toString()).toBe(
      fixture.clientSigner.peerId().toString()
    )

    // The repo PeerId and the subduction PeerId are disjoint identities.
    expect(clientBinding.subductionPeerId.toString()).not.toBe(
      clientBinding.repoPeerId
    )
    expect(serverBinding.subductionPeerId.toString()).not.toBe(
      serverBinding.repoPeerId
    )
  }, 10_000)

  // 2. Websocket path: event fires with no repoPeerId.
  it("websocket path: event fires with source.kind === 'websocket' and no repoPeerId", async () => {
    const server = await startSubductionWebsocketServer()
    cleanups.push(() => server.close())

    const repo = new Repo({
      peerId: "ws-binding-client" as PeerId,
      storage: new DummyStorageAdapter(),
      subductionWebsocketEndpoints: [server.url],
    })

    const events: SubductionPeerBinding[] = []
    repo.on("subduction-peer-bound", b => events.push(b))

    await waitForCondition(() => events.length > 0, 5000)
    expect(events).toHaveLength(1)
    const binding = events[0]
    expect(binding.source.kind).toBe("websocket")
    if (binding.source.kind !== "websocket") {
      throw new Error("expected websocket binding")
    }
    expect(binding.source.url).toBe(server.url)
    // `repoPeerId` is only present on the adapter arm — verify the
    // websocket discriminant doesn't carry it.
    expect("repoPeerId" in binding).toBe(false)
    expect(binding.subductionPeerId.toString()).toBe(
      server.signer.peerId().toString()
    )
  }, 10_000)

  // 3. A listener that throws does not abort the handshake. The
  //    subsequent sync round still completes, and the throw is
  //    routed through the connection-manager debug log rather than
  //    being raised out of `emit`.
  it("listener throw does not abort handshake or subsequent sync", async () => {
    const fixture = await makeAdapterPair()
    cleanups.push(() => fixture.close())

    fixture.clientRepo.on("subduction-peer-bound", () => {
      throw new Error("listener intentionally throws")
    })

    // A document created on the client should still reach the server,
    // proving the handshake completed despite the listener throw.
    const handle = fixture.clientRepo.create<{ value: number }>()
    handle.change(d => {
      d.value = 7
    })

    // The save throttle is 100 ms; let it land plus a small margin
    // before the server attempts to fetch.
    await pause(500)

    const serverHandle = await fixture.serverRepo.find<{ value: number }>(
      handle.url
    )
    await serverHandle.whenReady()
    expect(serverHandle.doc()!.value).toBe(7)
  }, 10_000)

  // 4. No peer to handshake with → no event.
  //
  // NB: a server-side policy that throws from `authorizeConnect` is
  // NOT a "failed handshake" from the connecting side's perspective.
  // The cryptographic handshake completes before the application-level
  // policy check runs, so the connecting side's `connectTransport`
  // resolves with a verified peer-id and the event fires — even
  // though the server then tears the connection down. The binding is
  // accurate (the remote really did present that identity); consumers
  // that want to filter for "policy-allowed" peers must do so via the
  // policy hooks, not by listening to this event.
  //
  // For an unambiguous "no binding" case, point the client at a
  // server that isn't listening at all. The TCP connect fails, so
  // neither `connectTransport` nor `acceptTransport` ever runs.
  it("transport-level handshake failure fires no event", async () => {
    // Bind a port and immediately release it, so we have a port we
    // know nobody is listening on.
    const tmp = new WebSocketServer({ port: 0 })
    await once(tmp, "listening")
    const addr = tmp.address()
    if (typeof addr === "string") throw new Error("unexpected address type")
    const deadPort = addr.port
    await new Promise<void>((r, e) =>
      tmp.close(err => (err ? e(err) : r()))
    )

    const repo = new Repo({
      peerId: "dead-port-client" as PeerId,
      storage: new DummyStorageAdapter(),
      subductionWebsocketEndpoints: [`ws://localhost:${deadPort}`],
    })
    cleanups.push(async () => {
      await repo.shutdown()
    })

    const listener = vi.fn()
    repo.on("subduction-peer-bound", listener)

    // Allow several reconnect attempts to occur.
    await pause(2000)

    expect(listener).not.toHaveBeenCalled()
  }, 10_000)
})
