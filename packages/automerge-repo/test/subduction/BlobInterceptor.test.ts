import { describe, it, expect, afterEach } from "vitest"
import { WebSocketServer } from "ws"
import {
  MemorySigner,
  MemoryStorage,
  Subduction,
  type Policy,
} from "@automerge/automerge-subduction/slim"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { type DocumentId, type PeerId } from "../../src/types.js"
import { type BlobInterceptor } from "../../src/subduction/source.js"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import { toSedimentreeId } from "../../src/subduction/helpers.js"
import { pause } from "../../src/helpers/pause.js"

const INTERCEPTOR_PREFIX = new Uint8Array([0xe2, 0xe2, 0xee, 0x01])

function makeMockInterceptor(): BlobInterceptor & {
  outgoingCount: number
  incomingCount: number
  documentIds: DocumentId[]
} {
  const interceptor = {
    outgoingCount: 0,
    incomingCount: 0,
    documentIds: [] as DocumentId[],

    async transformOutgoing(documentId: DocumentId, blob: Uint8Array) {
      interceptor.outgoingCount++
      interceptor.documentIds.push(documentId)
      const wrapped = new Uint8Array(INTERCEPTOR_PREFIX.length + blob.length)
      wrapped.set(INTERCEPTOR_PREFIX, 0)
      wrapped.set(blob, INTERCEPTOR_PREFIX.length)
      return wrapped
    },

    async transformIncoming(documentId: DocumentId, blob: Uint8Array) {
      interceptor.incomingCount++
      interceptor.documentIds.push(documentId)
      if (
        blob.length < INTERCEPTOR_PREFIX.length ||
        !INTERCEPTOR_PREFIX.every((b, i) => blob[i] === b)
      ) {
        return null
      }
      return blob.slice(INTERCEPTOR_PREFIX.length)
    },
  }
  return interceptor
}

class TestServer {
  #port: number
  #wss: WebSocketServer | null = null
  #subduction: Subduction | null = null

  get url() {
    return `ws://localhost:${this.#port}`
  }
  get subduction() {
    return this.#subduction!
  }

  private constructor(port: number) {
    this.#port = port
  }

  static async start(): Promise<TestServer> {
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>(r => wss.on("listening", r))
    const addr = wss.address()
    if (typeof addr === "string") throw new Error("unexpected address type")

    const subduction = new Subduction({
      signer: new MemorySigner(),
      storage: new MemoryStorage(),
    })
    const serviceName = `localhost:${addr.port}`
    wss.on("connection", ws => {
      subduction
        .acceptTransport(new WebSocketTransport(ws as any), serviceName)
        .catch(() => {})
    })

    const server = new TestServer(addr.port)
    server.#wss = wss
    server.#subduction = subduction
    return server
  }

  async stop() {
    if (this.#subduction) {
      await this.#subduction.disconnectAll()
      this.#subduction = null
    }
    if (this.#wss) {
      await new Promise<void>((r, e) =>
        this.#wss!.close(err => (err ? e(err) : r()))
      )
      this.#wss = null
    }
  }
}

async function waitForCondition(
  fn: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await pause(intervalMs)
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`)
}

async function waitForBlobs(server: TestServer, documentId: DocumentId) {
  const sid = toSedimentreeId(documentId)
  await waitForCondition(async () => {
    const blobs = await server.subduction.getBlobs(sid)
    return blobs !== undefined && blobs.length > 0
  }, 5000)
}

describe("BlobInterceptor", () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    cleanups.length = 0
  })

  async function startServer() {
    const server = await TestServer.start()
    cleanups.push(() => server.stop())
    return server
  }

  function createRepo(
    name: string,
    serverUrl: string,
    interceptor?: BlobInterceptor
  ) {
    return new Repo({
      peerId: name as PeerId,
      storage: new DummyStorageAdapter(),
      subductionWebsocketEndpoints: [serverUrl],
      subductionBlobInterceptor: interceptor,
    })
  }

  it("sync works end-to-end through interceptor", async () => {
    const server = await startServer()
    const aliceInterceptor = makeMockInterceptor()
    const bobInterceptor = makeMockInterceptor()

    const alice = createRepo("alice", server.url, aliceInterceptor)
    const bob = createRepo("bob", server.url, bobInterceptor)

    const aliceHandle = alice.create<{ text: string }>()
    aliceHandle.change(d => {
      d.text = "prefixed hello"
    })

    await waitForBlobs(server, aliceHandle.documentId)

    const bobHandle = await bob.find<{ text: string }>(aliceHandle.url)
    await bobHandle.whenReady()

    expect(bobHandle.doc()!.text).toBe("prefixed hello")
    expect(aliceInterceptor.outgoingCount).toBeGreaterThan(0)
    expect(bobInterceptor.incomingCount).toBeGreaterThan(0)
  }, 15_000)

  it("interceptor receives the correct documentId", async () => {
    const server = await startServer()
    const interceptor = makeMockInterceptor()
    const repo = createRepo("alice", server.url, interceptor)

    const handle = repo.create<{ text: string }>()
    handle.change(d => {
      d.text = "check id"
    })

    await waitForCondition(() => interceptor.outgoingCount > 0, 5000)

    expect(interceptor.documentIds.length).toBeGreaterThan(0)
    for (const id of interceptor.documentIds) {
      expect(id).toBe(handle.documentId)
    }
  }, 10_000)

  it("transformOutgoing throwing skips the commit without crashing", async () => {
    const server = await startServer()
    let callCount = 0
    const throwingInterceptor: BlobInterceptor = {
      async transformOutgoing() {
        callCount++
        throw new Error("transform failed on purpose")
      },
      async transformIncoming(_documentId, blob) {
        return blob
      },
    }
    const repo = createRepo("alice", server.url, throwingInterceptor)

    const handle = repo.create<{ text: string }>()
    handle.change(d => {
      d.text = "should not crash"
    })

    await waitForCondition(() => callCount > 0, 5000)

    const sid = toSedimentreeId(handle.documentId)
    const blobs = await server.subduction.getBlobs(sid)
    expect(blobs === undefined || blobs.length === 0).toBe(true)
  }, 10_000)
})

// The server policy initially denies access, then begins allowing it.
// This models the case where the authorization state needed to accept a
// push has not reached the server when subduction sync first tries to
// push transformed blobs.
describe("BlobInterceptor delayed server policy", () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    cleanups.length = 0
  })

  async function startPolicyServer(policy: Policy) {
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>(r => wss.on("listening", r))
    const addr = wss.address()
    if (typeof addr === "string") throw new Error("unexpected address type")

    const subduction = new Subduction({
      signer: new MemorySigner(),
      storage: new MemoryStorage(),
      policy,
    })
    const serviceName = `localhost:${addr.port}`
    wss.on("connection", ws => {
      subduction
        .acceptTransport(new WebSocketTransport(ws as any), serviceName)
        .catch(() => {})
    })

    const url = `ws://localhost:${addr.port}`
    cleanups.push(async () => {
      await subduction.disconnectAll()
      await new Promise<void>((r, e) => wss.close(err => (err ? e(err) : r())))
    })
    return { url, subduction }
  }

  it("blobs reach server after policy begins allowing", async () => {
    // The policy initially denies all access, then allows it after a
    // delay (as authorization state arrives).
    let policyAllowed = false
    const policy: Policy = {
      async authorizeConnect() {},
      async authorizeFetch() {
        if (!policyAllowed) throw new Error("not yet authorized")
      },
      async authorizePut() {
        if (!policyAllowed) throw new Error("not yet authorized")
      },
      async filterAuthorizedFetch(_peerId, ids) {
        return policyAllowed ? ids : []
      },
    }

    const server = await startPolicyServer(policy)
    const interceptor = makeMockInterceptor()

    const repo = new Repo({
      peerId: "sender" as PeerId,
      storage: new DummyStorageAdapter(),
      subductionWebsocketEndpoints: [server.url],
      subductionBlobInterceptor: interceptor,
      subductionTimeouts: {
        healInitialDelayMs: 500,
        healMaxDelayMs: 2000,
      },
    })

    const handle = repo.create<{ text: string }>()
    handle.change(d => {
      d.text = "encrypted content"
    })

    // Wait for at least one sync attempt to fail (policy denies).
    await pause(1500)

    // Verify blobs are NOT on the server yet.
    const sid = toSedimentreeId(handle.documentId)
    const blobsBefore = await server.subduction.getBlobs(sid)
    expect(blobsBefore?.length ?? 0).toBe(0)

    // Simulate the authorization state arriving: enable the policy.
    policyAllowed = true

    // The heal scheduler should retry and push the blobs.
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 15_000)

    const blobs = (await server.subduction.getBlobs(sid))!
    expect(blobs.length).toBeGreaterThan(0)
  }, 30_000)

  it("receiver gets blobs after delayed policy allow", async () => {
    let policyAllowed = false
    const policy: Policy = {
      async authorizeConnect() {},
      async authorizeFetch() {
        if (!policyAllowed) throw new Error("not yet authorized")
      },
      async authorizePut() {
        if (!policyAllowed) throw new Error("not yet authorized")
      },
      async filterAuthorizedFetch(_peerId, ids) {
        return policyAllowed ? ids : []
      },
    }

    const server = await startPolicyServer(policy)
    const senderInterceptor = makeMockInterceptor()
    const receiverInterceptor = makeMockInterceptor()

    const sender = new Repo({
      peerId: "sender" as PeerId,
      storage: new DummyStorageAdapter(),
      subductionWebsocketEndpoints: [server.url],
      subductionBlobInterceptor: senderInterceptor,
      subductionTimeouts: {
        healInitialDelayMs: 500,
        healMaxDelayMs: 2000,
      },
    })

    const senderHandle = sender.create<{ text: string }>()
    senderHandle.change(d => {
      d.text = "secret message"
    })

    // Wait for initial sync attempts to fail.
    await pause(1500)

    // Enable the policy (authorization state has arrived on the server).
    policyAllowed = true

    // Wait for sender's blobs to reach the server via heal retry.
    const sid = toSedimentreeId(senderHandle.documentId)
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 15_000)

    // Now create the receiver. The server has the blobs and
    // the policy allows access.
    const receiver = new Repo({
      peerId: "receiver" as PeerId,
      storage: new DummyStorageAdapter(),
      subductionWebsocketEndpoints: [server.url],
      subductionBlobInterceptor: receiverInterceptor,
      subductionTimeouts: {
        healInitialDelayMs: 500,
        healMaxDelayMs: 2000,
      },
    })

    const receiverHandle = await receiver.find<{ text: string }>(
      senderHandle.url
    )
    expect(receiverHandle.doc()!.text).toBe("secret message")
    expect(senderInterceptor.outgoingCount).toBeGreaterThan(0)
    expect(receiverInterceptor.incomingCount).toBeGreaterThan(0)
  }, 30_000)
})
