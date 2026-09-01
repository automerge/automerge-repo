import { describe, it, expect, afterEach } from "vitest"
import { WebSocketServer } from "ws"
import {
  MemorySigner,
  MemoryStorage,
  Subduction,
} from "@automerge/automerge-subduction/slim"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { type DocumentId, type PeerId } from "../../src/types.js"
import { type BlobInterceptor } from "../../src/subduction/source.js"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import { toSedimentreeId } from "../../src/subduction/helpers.js"
import { waitFor } from "../helpers/waitFor.js"

const PREFIX = new Uint8Array([0xe2, 0xe2, 0xee, 0x02])

/**
 * An interceptor that can pause decryption, simulating a peer whose decryption
 * key has not arrived yet.
 */
function makeGatedInterceptor(): BlobInterceptor & {
  rejectIncoming: boolean
  rejectedCount: number
} {
  const interceptor = {
    rejectIncoming: false,
    // How many incoming blobs have been rejected because the key has not
    // arrived. Lets a test await the moment a peer has actually processed
    // (and declined) a blob instead of sleeping for a fixed interval.
    rejectedCount: 0,

    async transformOutgoing(
      _documentId: DocumentId,
      _commitId: string,
      _parents: string[],
      blob: Uint8Array
    ) {
      const wrapped = new Uint8Array(PREFIX.length + blob.length)
      wrapped.set(PREFIX, 0)
      wrapped.set(blob, PREFIX.length)
      return wrapped
    },

    async transformIncoming(
      _documentId: DocumentId,
      _commitId: string,
      blob: Uint8Array
    ) {
      if (interceptor.rejectIncoming) {
        interceptor.rejectedCount++
        return null
      }
      if (
        blob.length < PREFIX.length ||
        !PREFIX.every((b, i) => blob[i] === b)
      ) {
        return null
      }
      return blob.slice(PREFIX.length)
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

describe("blobs that arrive before their key", () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
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
    interceptor: BlobInterceptor
  ) {
    return new Repo({
      peerId: name as PeerId,
      storage: new DummyStorageAdapter(),
      subductionWebsocketEndpoints: [serverUrl],
      subductionBlobInterceptor: interceptor,
    })
  }

  it("keeps an untransformable blob so a later retry can apply it", async () => {
    const server = await startServer()
    const alice = createRepo("alice", server.url, makeGatedInterceptor())
    const bobInterceptor = makeGatedInterceptor()
    const bob = createRepo("bob", server.url, bobInterceptor)

    const aliceHandle = alice.create<{ text: string }>()
    aliceHandle.change(d => {
      d.text = "before"
    })

    const bobHandle = await bob.find<{ text: string }>(aliceHandle.url)
    await bobHandle.whenReady()
    expect(bobHandle.doc()!.text).toBe("before")

    bobInterceptor.rejectIncoming = true

    aliceHandle.change(d => {
      d.text = "after"
    })

    const sid = toSedimentreeId(aliceHandle.documentId)
    await waitFor(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      expect(blobs?.length ?? 0).toBeGreaterThan(1)
    }, 10_000)

    // Wait until Bob has actually received the new blob and its interceptor
    // declined it (the key has not arrived) rather than sleeping for a fixed
    // interval. That rejection is the point at which the blob could wrongly be
    // applied; transformIncoming returning null means it was not, so Bob must
    // still show the old value.
    await waitFor(() => {
      expect(bobInterceptor.rejectedCount).toBeGreaterThan(0)
    }, 10_000)
    expect(bobHandle.doc()!.text).toBe("before")

    bobInterceptor.rejectIncoming = false
    bob.shareConfigChanged()

    await waitFor(() => {
      expect(bobHandle.doc()!.text).toBe("after")
    }, 10_000)
  }, 30_000)
})
