import { next as A } from "@automerge/automerge"
import { describe, expect, it } from "vitest"
import { Repo } from "../src/Repo.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import type { DocHandle } from "../src/DocHandle.js"
import type { DocumentId, PeerId } from "../src/index.js"
import type { StorageAdapterInterface } from "../src/storage/StorageAdapterInterface.js"
import type { Chunk, StorageKey } from "../src/storage/types.js"
import { linkRepos } from "./helpers/linkRepos.js"

type LogDoc = { log: string[] }

/**
 * Wraps a storage adapter. While armed, every `loadRange` for `documentId`
 * waits until {@link GatedStorageAdapter.release}, so a document stays on
 * disk but not in memory for as long as the test needs.
 */
class GatedStorageAdapter implements StorageAdapterInterface {
  #inner: StorageAdapterInterface
  #documentId: DocumentId
  #gate?: PromiseWithResolvers<void>
  #readStarted = Promise.withResolvers<void>()

  constructor(inner: StorageAdapterInterface, documentId: DocumentId) {
    this.#inner = inner
    this.#documentId = documentId
  }

  /** Hold reads of the document until {@link release}. */
  arm(): void {
    this.#gate = Promise.withResolvers<void>()
    this.#readStarted = Promise.withResolvers<void>()
  }

  /** Resolves once a held read has started. */
  get readStarted(): Promise<void> {
    return this.#readStarted.promise
  }

  release(): void {
    this.#gate?.resolve()
    this.#gate = undefined
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    if (this.#gate && keyPrefix[0] === this.#documentId) {
      this.#readStarted.resolve()
      await this.#gate.promise
    }
    return this.#inner.loadRange(keyPrefix)
  }
  load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.#inner.load(key)
  }
  save(key: StorageKey, data: Uint8Array): Promise<void> {
    return this.#inner.save(key, data)
  }
  remove(key: StorageKey): Promise<void> {
    return this.#inner.remove(key)
  }
  removeRange(keyPrefix: StorageKey): Promise<void> {
    return this.#inner.removeRange(keyPrefix)
  }
}

/** Resolves once `server` has activated `client` on the document. */
const serverActivated = (
  server: Repo,
  client: Repo,
  documentId: DocumentId
): Promise<void> =>
  new Promise(resolve =>
    server.synchronizer.on("open-doc", payload => {
      if (payload.peerId === client.peerId && payload.documentId === documentId)
        resolve()
    })
  )

/**
 * Resolves once the server's copy has `heads`; rejects after `budgetMs`
 * (a failure budget: a livelocked exchange never converges).
 */
const serverReaches = (
  server: Repo,
  documentId: DocumentId,
  heads: A.Heads,
  budgetMs = 2000
): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const timer = setTimeout(
    () => reject(new Error("server never reached the client's heads")),
    budgetMs
  )
  const check = (handle: DocHandle<unknown>) => {
    if (A.equals(handle.heads(), heads)) {
      clearTimeout(timer)
      resolve()
      return true
    }
    return false
  }
  const handle = server.handles[documentId]
  if (!check(handle)) {
    const onHeads = () => {
      if (check(handle)) handle.off("heads-changed", onHeads)
    }
    handle.on("heads-changed", onHeads)
  }
  return promise
}

/** A document large enough that a full re-upload dwarfs one change. */
const createLargeDoc = (repo: Repo) => {
  const handle = repo.create<LogDoc>({ log: [] })
  for (let i = 0; i < 1000; i++) {
    handle.change(d => {
      d.log.push(`entry ${i} ${"x".repeat(40)}`)
    })
  }
  return handle
}

const shareConfig = { announce: async () => false, access: async () => true }

describe("a server reloading a document from storage", () => {
  it("a reconnecting client's exchange after a server restart stays small", async () => {
    const disk = new DummyStorageAdapter()
    const client = new Repo({
      peerId: "client" as PeerId,
      storage: new DummyStorageAdapter(),
    })
    const first = new Repo({
      peerId: "server" as PeerId,
      storage: disk,
      shareConfig,
    })
    const firstLink = await linkRepos(client, first)

    const handle = createLargeDoc(client)
    const { documentId } = handle
    await first.find(handle.url)
    await serverReaches(first, documentId, handle.heads())
    await first.flush()
    firstLink.unlink()
    await first.shutdown()

    // Edit while disconnected, so the restarted server must receive it.
    handle.change(d => {
      d.log.push("offline edit")
    })

    const storage = new GatedStorageAdapter(disk, documentId)
    storage.arm()
    const restarted = new Repo({
      peerId: "server" as PeerId,
      storage,
      shareConfig,
    })
    const activated = serverActivated(restarted, client, documentId)
    const { stats } = await linkRepos(client, restarted)

    // The client's first message arrives while storage is still loading.
    await storage.readStarted
    await activated
    storage.release()
    await serverReaches(restarted, documentId, handle.heads())

    expect(stats.bytesToRight).toBeLessThan(A.save(handle.doc()).byteLength / 4)
  })

  it("a change that triggers a reload converges without a re-upload", async () => {
    const disk = new DummyStorageAdapter()
    const client = new Repo({
      peerId: "client" as PeerId,
      storage: new DummyStorageAdapter(),
    })
    const handle = createLargeDoc(client)
    const { documentId } = handle
    const storage = new GatedStorageAdapter(disk, documentId)
    const server = new Repo({
      peerId: "server" as PeerId,
      storage,
      shareConfig,
    })
    const { stats } = await linkRepos(client, server)

    await server.find(handle.url)
    await serverReaches(server, documentId, handle.heads())
    await server.flush()
    await server.removeFromCache(documentId)

    // The client's next change reaches a server that must reload the
    // document, and the client is a peer that has it.
    storage.arm()
    stats.bytesToRight = 0
    const activated = serverActivated(server, client, documentId)
    handle.change(d => {
      d.log.push("edit after reload")
    })
    await storage.readStarted
    await activated
    storage.release()
    await serverReaches(server, documentId, handle.heads())

    expect(stats.bytesToRight).toBeLessThan(A.save(handle.doc()).byteLength / 4)
  })

  it("a change that arrives after activation while storage loads converges without a re-upload", async () => {
    const disk = new DummyStorageAdapter()
    const client = new Repo({
      peerId: "client" as PeerId,
      storage: new DummyStorageAdapter(),
    })
    const handle = createLargeDoc(client)
    const { documentId } = handle
    const storage = new GatedStorageAdapter(disk, documentId)
    const server = new Repo({
      peerId: "server" as PeerId,
      storage,
      shareConfig,
    })
    const { stats } = await linkRepos(client, server)

    await server.find(handle.url)
    await serverReaches(server, documentId, handle.heads())
    await server.flush()
    await server.removeFromCache(documentId)

    storage.arm()
    stats.bytesToRight = 0
    const activated = serverActivated(server, client, documentId)
    handle.change(d => {
      d.log.push("first edit")
    })
    await storage.readStarted
    await activated

    // A second change reaches the activated peer while storage is loading.
    const received = new Promise<void>(resolve =>
      server.networkSubsystem.on("message", message => {
        if (message.type === "sync" && message.documentId === documentId) {
          resolve()
        }
      })
    )
    handle.change(d => {
      d.log.push("second edit")
    })
    await received
    storage.release()
    await serverReaches(server, documentId, handle.heads())

    expect(stats.bytesToRight).toBeLessThan(A.save(handle.doc()).byteLength / 4)
  })
})
