import { afterEach, describe, expect, expectTypeOf, it } from "vitest"
import { WebSocketServer } from "ws"
import {
  MemorySigner,
  MemoryStorage,
  Subduction,
} from "@automerge/automerge-subduction"
import {
  automergeDocType,
  Repo,
  type CrdtDocHandle,
  type PeerId,
} from "../src/index.js"
import {
  gCounterDocType,
  type GCounterDocType,
  type GCounterView,
} from "./helpers/gCounterDocType.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import { pause } from "../src/helpers/pause.js"
import { toSedimentreeId } from "../src/subduction/helpers.js"
import { WebSocketTransport } from "../src/subduction/websocket-transport.js"

class TestServer {
  #port: number
  #wss: WebSocketServer | null = null
  #subduction: Subduction | null = null
  #signer: MemorySigner | null = null
  #storage: MemoryStorage | null = null

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
    const tmp = new WebSocketServer({ port: 0 })
    await new Promise<void>(r => tmp.on("listening", r))
    const addr = tmp.address()
    if (typeof addr === "string") throw new Error("unexpected address type")
    const port = addr.port
    await new Promise<void>((resolve, reject) =>
      tmp.close(err => (err ? reject(err) : resolve()))
    )
    const server = new TestServer(port)
    await server.restart()
    return server
  }

  async restart(): Promise<void> {
    if (this.#wss) await this.close()

    this.#signer = new MemorySigner()
    this.#storage = new MemoryStorage()
    this.#subduction = new Subduction({
      signer: this.#signer,
      storage: this.#storage,
    })
    const serviceName = `localhost:${this.#port}`

    this.#wss = new WebSocketServer({ port: this.#port })
    await new Promise<void>(r => this.#wss!.on("listening", r))

    this.#wss.on("connection", ws => {
      const transport = new WebSocketTransport(ws as any)
      this.#subduction!.acceptTransport(transport, serviceName).catch(() => {})
    })
  }

  async close(): Promise<void> {
    if (this.#subduction) {
      await this.#subduction.disconnectAll()
      this.#subduction = null
    }
    if (this.#wss) {
      await new Promise<void>((resolve, reject) =>
        this.#wss!.close(err => (err ? reject(err) : resolve()))
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

describe("multi-CRDT document types", () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    cleanups.length = 0
  })

  it("types DocHandle from the find/create document type", async () => {
    const counterType = gCounterDocType()
    const repo = new Repo()
    cleanups.push(() => repo.shutdown())

    const initialized = repo.create({ value: 5 }, counterType)
    expectTypeOf(initialized).toEqualTypeOf<CrdtDocHandle<GCounterDocType>>()
    expect(initialized.doc()).toEqual({ value: 5 })

    const counter = repo.create(counterType)
    expectTypeOf(counter).toEqualTypeOf<CrdtDocHandle<GCounterDocType>>()
    expectTypeOf(counter.doc()).toEqualTypeOf<GCounterView>()

    counter.change(tx => tx.increment(2))
    expect(counter.doc()).toEqual({ value: 2 })

    const pinned = counter.view(counter.heads())
    expectTypeOf(pinned).toEqualTypeOf<CrdtDocHandle<GCounterDocType>>()
    expect(pinned.doc()).toEqual({ value: 2 })

    const found = await repo.find(counter.url, counterType)
    expectTypeOf(found).toEqualTypeOf<CrdtDocHandle<GCounterDocType>>()
    expect(found.doc()).toEqual({ value: 2 })

    const progressFound = await repo
      .findWithProgress(counter.url, counterType)
      .whenReady()
    expectTypeOf(progressFound).toEqualTypeOf<CrdtDocHandle<GCounterDocType>>()
    expect(progressFound.doc()).toEqual({ value: 2 })

    const alreadyOpenFound = await repo.find(counter.url)
    expect(alreadyOpenFound.doc()).toEqual({ value: 2 })
  })

  it("rejects opening the same document id as two CRDT types", async () => {
    const repo = new Repo()
    cleanups.push(() => repo.shutdown())

    const counter = repo.create(gCounterDocType())

    await expect(repo.find(counter.url, automergeDocType())).rejects.toThrow(
      /already open as counter/
    )
    await expect(repo.find(counter.url, "counter" as any)).rejects.toThrow(
      /document type object/
    )
  })

  it("syncs a non-Automerge counter through Subduction", async () => {
    const server = await TestServer.start()
    cleanups.push(() => server.close())

    const alice = new Repo({
      peerId: "alice" as PeerId,
      storage: new DummyStorageAdapter(),
      subductionWebsocketEndpoints: [server.url],
    })
    const bob = new Repo({
      peerId: "bob" as PeerId,
      storage: new DummyStorageAdapter(),
      subductionWebsocketEndpoints: [server.url],
    })
    cleanups.push(() => alice.shutdown())
    cleanups.push(() => bob.shutdown())

    const counterType = gCounterDocType()
    const aliceCounter = alice.create(counterType)
    aliceCounter.change(tx => tx.increment(3))
    await alice.flush()

    const sid = toSedimentreeId(aliceCounter.documentId)
    await waitForCondition(async () => {
      const blobs = await server.subduction.getBlobs(sid)
      return blobs !== undefined && blobs.length > 0
    }, 5000)

    const bobCounter = await bob.find(aliceCounter.url, counterType)
    expect(bobCounter.doc()).toEqual({ value: 3 })
  }, 10_000)
})
