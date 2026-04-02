import { describe, it, expect, afterEach, vi } from "vitest"
import { once } from "events"
import { WebSocketServer } from "ws"

import {
  Subduction,
  MemorySigner,
  MemoryStorage,
  type Policy,
} from "@automerge/automerge-subduction"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { type PeerId } from "../../src/types.js"
import { toSedimentreeId } from "../../src/subduction/helpers.js"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import { pause } from "../../src/helpers/pause.js"

interface TestServer {
  port: number
  url: string
  subduction: Subduction
  wss: WebSocketServer
  close(): Promise<void>
}

async function startSubductionServer(
  listenPort = 0,
  policy?: Policy
): Promise<TestServer> {
  const signer = new MemorySigner()
  const storage = new MemoryStorage()
  const subduction = await Subduction.hydrate(
    signer,
    storage,
    undefined, // service_name
    undefined, // hash_metric_override
    undefined, // max_pending_blob_requests
    policy
  )

  const wss = new WebSocketServer({ port: listenPort })
  await once(wss, "listening")

  const address = wss.address()
  if (typeof address === "string") throw new Error("unexpected address type")
  const port = address.port
  const url = `ws://localhost:${port}`

  const serviceName = `localhost:${port}`

  wss.on("connection", ws => {
    const transport = new WebSocketTransport(ws as any)
    subduction.acceptTransport(transport, serviceName).catch(() => {
      // Connection rejected by policy — expected in deny tests
    })
  })

  return {
    port,
    url,
    subduction,
    wss,
    async close() {
      await subduction.disconnectAll()
      await new Promise<void>((resolve, reject) =>
        wss.close(err => (err ? reject(err) : resolve()))
      )
    },
  }
}

/** Allow-all policy that tracks calls via spies. */
function createAllowAllPolicy(): Policy & {
  spies: Record<string, ReturnType<typeof vi.fn>>
} {
  const spies = {
    authorizeConnect: vi.fn(),
    authorizeFetch: vi.fn(),
    authorizePut: vi.fn(),
    filterAuthorizedFetch: vi.fn(),
  }

  return {
    spies,
    async authorizeConnect(peerId) {
      spies.authorizeConnect(peerId)
    },
    async authorizeFetch(peerId, sedimentreeId) {
      spies.authorizeFetch(peerId, sedimentreeId)
    },
    async authorizePut(requestor, author, sedimentreeId) {
      spies.authorizePut(requestor, author, sedimentreeId)
    },
    async filterAuthorizedFetch(peerId, ids) {
      spies.filterAuthorizedFetch(peerId, ids)
      return ids
    },
  }
}

describe("SubductionPolicy", () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    cleanups.length = 0
  })

  it("server policy authorizeConnect is called when a client connects", async () => {
    const policy = createAllowAllPolicy()
    const server = await startSubductionServer(0, policy)
    cleanups.push(() => server.close())

    const repo = new Repo({
      peerId: "policy-test-client" as PeerId,
      storage: new DummyStorageAdapter(),
      subductionWebsocketEndpoints: [server.url],
    })

    // Wait for the connection to establish and sync to happen
    const handle = repo.create<{ value: number }>()
    handle.change(d => {
      d.value = 1
    })

    const sid = toSedimentreeId(handle.documentId)
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 5000)

    expect(policy.spies.authorizeConnect).toHaveBeenCalled()
  })

  it("client policy is wired through RepoConfig.subductionPolicy", async () => {
    const policy = createAllowAllPolicy()
    const server = await startSubductionServer()
    cleanups.push(() => server.close())

    const repo = new Repo({
      peerId: "policy-client" as PeerId,
      storage: new DummyStorageAdapter(),
      subductionWebsocketEndpoints: [server.url],
      subductionPolicy: policy,
    })

    const handle = repo.create<{ value: number }>()
    handle.change(d => {
      d.value = 42
    })

    const sid = toSedimentreeId(handle.documentId)
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 5000)

    // The client-side policy should have been invoked during the sync.
    // authorizeConnect fires when the server's transport is accepted by the client.
    expect(policy.spies.authorizeConnect).toHaveBeenCalled()
  })

  it("server rejects sync when authorizePut denies the operation", async () => {
    const authorizePutSpy = vi.fn()

    const denyPutPolicy: Policy = {
      async authorizeConnect() {},
      async authorizeFetch() {},
      async authorizePut(requestor, author, sedimentreeId) {
        authorizePutSpy(requestor, author, sedimentreeId)
        throw new Error("put denied by policy")
      },
      async filterAuthorizedFetch(_peerId, ids) {
        return ids
      },
    }

    const server = await startSubductionServer(0, denyPutPolicy)
    cleanups.push(() => server.close())

    const repo = new Repo({
      peerId: "denied-client" as PeerId,
      storage: new DummyStorageAdapter(),
      subductionWebsocketEndpoints: [server.url],
    })

    const handle = repo.create<{ value: string }>()
    handle.change(d => {
      d.value = "should not arrive"
    })

    // Give ample time for sync attempts
    await pause(3000)

    // Verify the policy was actually invoked (not a false positive from
    // a connection failure preventing data from ever reaching the server).
    expect(authorizePutSpy).toHaveBeenCalled()

    // The server should NOT have any blobs for this document
    const sid = toSedimentreeId(handle.documentId)
    const blobs = await server.subduction.getBlobs(sid)
    expect(blobs?.length ?? 0).toBe(0)
  }, 10_000)
})

async function waitForCondition(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await pause(intervalMs)
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`)
}
