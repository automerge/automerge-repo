/**
 * A fragment whose checkpoints list its own head never contributes a head:
 * `Sedimentree::heads_assuming_minimal` (subduction 0.17) drops every id that
 * appears among any fragment's checkpoints. Automerge before 3.5 puts every
 * fragment's head among its checkpoints, and clients that bundled with it
 * stored fragments of that shape. A document whose newest change is such a
 * fragment's head is advertised with no heads by every peer holding the
 * fragment, while automerge reports the head, so a collection sync that
 * compares the two never converges.
 */
import * as A from "@automerge/automerge"
import {
  BlobMeta,
  CommitId,
  Fragment,
  FragmentInput,
  MemorySigner,
  MemoryStorage,
  SedimentreeId,
  Subduction,
} from "@automerge/automerge-subduction/slim"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"

import { WebSocketClientAdapter } from "../../../automerge-repo-network-websocket/src/WebSocketClientAdapter.js"
import { WebSocketServerAdapter } from "../../../automerge-repo-network-websocket/src/WebSocketServerAdapter.js"
import {
  generateAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "../../src/AutomergeUrl.js"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { initSubduction } from "../../src/initSubduction.js"
import {
  fragmentCheckpoints,
  selfCheckpointRepair,
} from "../../src/subduction/fragmentCheckpoints.js"
import { toSedimentreeId } from "../../src/subduction/helpers.js"
import { SubductionStorageBridge } from "../../src/subduction/storage.js"
import type { Chunk, StorageKey } from "../../src/storage/types.js"
import type { StorageAdapterInterface } from "../../src/storage/StorageAdapterInterface.js"
import type { DocumentId, PeerId } from "../../src/types.js"
import { waitFor } from "../helpers/waitFor.js"

beforeAll(async () => {
  await initSubduction()
})

type Doc = Record<string, string>

/**
 * Three changes whose last hash starts with a zero byte (depth 1 under the
 * default metric): the whole document is one root-anchored fragment and no
 * loose commits.
 */
function fragmentOnlyDoc(): { doc: A.Doc<Doc>; head: string } {
  for (let attempt = 0; attempt < 100_000; attempt++) {
    let doc = A.init<Doc>()
    for (let i = 0; i < 3; i++) {
      doc = A.change(doc, d => {
        d[`key${i}`] = `${attempt}:${i}`
      })
    }
    const heads = A.getHeads(doc)
    if (
      heads.length === 1 &&
      A.getFragmentMetadata(doc, 0).length === 0 &&
      A.getFragmentMetadata(doc, { start: 1 }).length === 1
    ) {
      return { doc, head: heads[0] }
    }
  }
  throw new Error("no fragment-only document found")
}

/** The fragment of `doc`, bundled as a client on automerge < 3.5 did. */
function olderClientFragment(sid: SedimentreeId, doc: A.Doc<Doc>) {
  const [meta] = A.getFragmentMetadata(doc, { start: 1 })
  const [blob] = A.bundleFragmentMetadata(doc, [meta])
  const head = CommitId.fromHexString(meta.head)
  const boundary = meta.boundary.map(b => CommitId.fromHexString(b))
  return {
    blob,
    stored: () => new Fragment(sid, head, boundary, [head], new BlobMeta(blob)),
    repaired: () => new Fragment(sid, head, boundary, [], new BlobMeta(blob)),
  }
}

/** Persist `doc` into `storage` the way a client on automerge < 3.5 did. */
async function storeAsOlderClient(
  storage: StorageAdapterInterface,
  sid: SedimentreeId,
  doc: A.Doc<Doc>
): Promise<Subduction> {
  const bridge = new SubductionStorageBridge(storage)
  const writer = new Subduction({ signer: new MemorySigner(), storage: bridge })
  const { blob, stored } = olderClientFragment(sid, doc)
  await writer.storeBuiltBatch(sid, [], [new FragmentInput(stored(), blob)])
  await bridge.awaitSettled()
  return writer
}

async function headsIn(
  subduction: Subduction,
  sid: SedimentreeId
): Promise<string[] | undefined> {
  const entry = (await subduction.getAllHeads()).find(
    e => e.id.toString() === sid.toString()
  )
  return entry?.heads.map(h => h.toHexString())
}

async function advertisedHeads(repo: Repo, documentId: DocumentId) {
  return headsIn(await repo.subduction, toSedimentreeId(documentId))
}

function newDocumentId(): DocumentId {
  return parseAutomergeUrl(generateAutomergeUrl()).documentId
}

describe("fragments whose checkpoints list their own head", () => {
  const cleanups: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    cleanups.length = 0
  })

  async function startServer() {
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>(resolve => wss.on("listening", resolve))
    const address = wss.address()
    if (address === null || typeof address === "string") {
      throw new Error("bad address")
    }
    const serverAdapter = new WebSocketServerAdapter(wss)
    const repo = new Repo({
      peerId: `server-${address.port}` as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      subductionAdapters: [
        {
          adapter: serverAdapter,
          serviceName: `localhost:${address.port}`,
          role: "accept",
        },
      ],
      sharePolicy: async () => true,
    })
    cleanups.push(async () => {
      serverAdapter.disconnect()
      await new Promise<void>((resolve, reject) =>
        wss.close(e => (e ? reject(e) : resolve()))
      )
    })
    return { repo, url: `ws://localhost:${address.port}` }
  }

  function startClient(url: string, storage: StorageAdapterInterface) {
    const adapter = new WebSocketClientAdapter(url)
    const repo = new Repo({
      peerId: `client-${Math.random().toString(36).slice(2, 7)}` as PeerId,
      storage,
      network: [],
      subductionAdapters: [{ adapter, serviceName: new URL(url).host }],
      sharePolicy: async () => true,
    })
    cleanups.push(() => adapter.disconnect())
    return repo
  }

  it("a document whose newest change starts a fragment is advertised at that change", async () => {
    const { doc, head } = fragmentOnlyDoc()
    const repo = new Repo({ storage: new DummyStorageAdapter(), network: [] })
    cleanups.push(() => repo.shutdown())

    const handle = repo.import<Doc>(A.save(doc))
    await repo.flush([handle.documentId])

    expect(await advertisedHeads(repo, handle.documentId)).toEqual([head])
  })

  it("a stored fragment that lists its own head is rewritten when its document is attached", async () => {
    const { doc, head } = fragmentOnlyDoc()
    const documentId = newDocumentId()
    const sid = toSedimentreeId(documentId)
    const storage = new DummyStorageAdapter()
    const writer = await storeAsOlderClient(storage, sid, doc)
    expect(
      await headsIn(writer, sid),
      "subduction advertises no heads for the stored fragment"
    ).toEqual([])

    const server = await startServer()
    const client = startClient(server.url, storage)
    const handle = await client.find<Doc>(stringifyAutomergeUrl({ documentId }))
    expect(A.getHeads(handle.doc())).toEqual([head])

    // The server had no copy, so it takes the one the client pushes.
    await waitFor(async () => {
      expect(await advertisedHeads(server.repo, documentId)).toEqual([head])
    }, 8000)
    expect(await advertisedHeads(client, documentId)).toEqual([head])

    // The rewrite is on disk: an engine loading the client's storage from
    // scratch (the next session) advertises the head too.
    await client.flush()
    const reloaded = new Subduction({
      signer: new MemorySigner(),
      storage: new SubductionStorageBridge(storage),
    })
    expect(await headsIn(reloaded, sid)).toEqual([head])
  }, 20_000)

  it("the rewrite reaches peers even when storage is slower than the first sync round", async () => {
    // Subduction keeps one fragment per head in memory and, on a collision,
    // the one with the lower digest. Pick a document id for which the stored
    // fragment would win that tiebreak, so a rewrite that lands after the
    // engine loaded the tree is lost for the session and the stored fragment
    // is what gets pushed.
    const { doc, head } = fragmentOnlyDoc()
    let documentId: DocumentId
    for (;;) {
      documentId = newDocumentId()
      if (await storedFragmentWinsTiebreak(toSedimentreeId(documentId), doc)) {
        break
      }
    }
    const sid = toSedimentreeId(documentId)
    const storage = new SlowFragmentScan(new DummyStorageAdapter())
    await storeAsOlderClient(storage, sid, doc)
    storage.holdFirstScan()

    const server = await startServer()
    const client = startClient(server.url, storage)
    const found = client.find<Doc>(stringifyAutomergeUrl({ documentId }))
    setTimeout(() => storage.release(), 300)
    const handle = await found
    expect(A.getHeads(handle.doc())).toEqual([head])

    await waitFor(async () => {
      expect(await advertisedHeads(server.repo, documentId)).toEqual([head])
    }, 8000)
  }, 20_000)
})

describe("fragmentCheckpoints", () => {
  it("drops the fragment's own head and boundary", () => {
    expect(
      fragmentCheckpoints({
        head: "aa",
        boundary: ["bb"],
        checkpoints: ["aa", "bb", "cc"],
      })
    ).toEqual(["cc"])
  })
})

describe("selfCheckpointRepair", () => {
  const sid = SedimentreeId.fromBytes(new Uint8Array(32).fill(0x01))
  const head = new Uint8Array(32).fill(0x0a)
  const boundary = new Uint8Array(32).fill(0x0b)
  const interior = new Uint8Array(32).fill(0x0c)
  const prefix = (id: Uint8Array) => id.slice(0, 12)

  /** A fragment as subduction encodes it into storage. */
  async function storedFragment(
    boundaryIds: Uint8Array[],
    checkpointIds: Uint8Array[],
    blobSize = 100
  ): Promise<Uint8Array> {
    const storage = new MemoryStorage()
    const engine = new Subduction({ signer: new MemorySigner(), storage })
    const blob = new Uint8Array(blobSize).fill(0x2a)
    const fragment = new Fragment(
      sid,
      new CommitId(head),
      boundaryIds.map(b => new CommitId(b)),
      checkpointIds.map(c => new CommitId(c)),
      new BlobMeta(blob)
    )
    await engine.storeBuiltBatch(sid, [], [new FragmentInput(fragment, blob)])
    const [stored] = await storage.loadAllFragments(sid)
    return stored.signed.encode()
  }

  it("returns the fragment without its head among its checkpoints", async () => {
    expect(selfCheckpointRepair(await storedFragment([], [head]))).toEqual({
      head,
      boundary: [],
      checkpoints: [],
    })
  })

  it("drops boundary checkpoints along with the head", async () => {
    const signed = await storedFragment([boundary], [head, boundary, interior])
    expect(selfCheckpointRepair(signed)).toEqual({
      head,
      boundary: [boundary],
      checkpoints: [prefix(interior)],
    })
  })

  it("leaves a fragment that does not list its own head alone", async () => {
    expect(
      selfCheckpointRepair(await storedFragment([boundary], [interior]))
    ).toBeUndefined()
    expect(selfCheckpointRepair(await storedFragment([], []))).toBeUndefined()
  })

  it.each([0, 247, 248, 503, 504, 66_039, 66_040])(
    "reads a fragment whose blob is %i bytes",
    async blobSize => {
      const signed = await storedFragment([boundary], [head], blobSize)
      expect(selfCheckpointRepair(signed)).toEqual({
        head,
        boundary: [boundary],
        checkpoints: [],
      })
    }
  )

  it("rejects bytes that are not a signed fragment", async () => {
    const signed = await storedFragment([], [head])
    const truncated = signed.subarray(0, signed.length - 1)
    expect(selfCheckpointRepair(truncated)).toBeUndefined()
    expect(selfCheckpointRepair(new Uint8Array([...signed, 0]))).toBeUndefined()
    const otherSchema = new Uint8Array(signed)
    otherSchema[2] = "C".charCodeAt(0)
    expect(selfCheckpointRepair(otherSchema)).toBeUndefined()
    expect(selfCheckpointRepair(new Uint8Array(0))).toBeUndefined()
  })
})

/**
 * Whether subduction, holding the fragment an older client stored for `doc`,
 * keeps it when the repaired fragment (same head) is stored next.
 */
async function storedFragmentWinsTiebreak(
  sid: SedimentreeId,
  doc: A.Doc<Doc>
): Promise<boolean> {
  const engine = new Subduction({
    signer: new MemorySigner(),
    storage: new MemoryStorage(),
  })
  const { blob, stored, repaired } = olderClientFragment(sid, doc)
  await engine.storeBuiltBatch(sid, [], [new FragmentInput(stored(), blob)])
  await engine.storeBuiltBatch(sid, [], [new FragmentInput(repaired(), blob)])
  return (await headsIn(engine, sid))?.length === 0
}

/**
 * Holds the first scan of a sedimentree's fragment records (the one a Repo
 * makes when a document is attached) until released; everything else,
 * including the scans subduction makes to load the tree, passes through.
 */
class SlowFragmentScan implements StorageAdapterInterface {
  #inner: StorageAdapterInterface
  #holding = false
  #held: Array<() => void> = []
  #released = false

  constructor(inner: StorageAdapterInterface) {
    this.#inner = inner
  }

  holdFirstScan() {
    this.#holding = true
  }

  release() {
    this.#released = true
    for (const resume of this.#held.splice(0)) resume()
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    if (this.#holding && keyPrefix[1] === "fragments") {
      this.#holding = false
      if (!this.#released) {
        await new Promise<void>(resolve => this.#held.push(resolve))
      }
    }
    return this.#inner.loadRange(keyPrefix)
  }

  load(key: StorageKey) {
    return this.#inner.load(key)
  }
  save(key: StorageKey, data: Uint8Array) {
    return this.#inner.save(key, data)
  }
  remove(key: StorageKey) {
    return this.#inner.remove(key)
  }
  removeRange(keyPrefix: StorageKey) {
    return this.#inner.removeRange(keyPrefix)
  }
  saveBatch(entries: Array<[StorageKey, Uint8Array]>) {
    return this.#inner.saveBatch(entries)
  }
}
