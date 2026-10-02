import { MemorySigner } from "@automerge/subduction"
import { Repo } from "@automerge/automerge-repo"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createSubductionPeer,
  type SubductionPeer,
  type SubductionServer,
} from "../src/index.js"

const { openTransport } = vi.hoisted(() => ({ openTransport: vi.fn() }))
vi.mock("../src/websocket.js", () => ({ openTransport }))

describe("Subduction peer factory", () => {
  const peers: SubductionPeer[] = []
  function create(options = {}) {
    const peer = createSubductionPeer(options)
    peers.push(peer)
    return peer
  }
  afterEach(async () => {
    await Promise.all(peers.splice(0).map(peer => peer.close().catch(() => {})))
    vi.restoreAllMocks()
    openTransport.mockReset()
  })

  it("creates an immediately usable local Repo and owns its generated signer", async () => {
    const generated = vi.spyOn(MemorySigner, "generate")
    const peer = create()
    const signer = generated.mock.results[0].value as MemorySigner
    const free = vi.spyOn(signer, "free")
    const id = signer.peerId()
    try {
      expect(peer.peerId).toBe(id.toString())
    } finally {
      id.free()
    }
    const repo = new Repo({ backend: peer.backend })
    try {
      const handle = await repo.create({ count: 0 })
      await handle.change(doc => {
        doc.count++
      })
      expect(handle.doc()!.count).toBe(1)
    } finally {
      await repo.shutdown()
    }
    expect(free).not.toHaveBeenCalled()
    const closing = peer.close()
    expect(peer.close()).toBe(closing)
    await closing
    expect(free).toHaveBeenCalledOnce()
    expect(() => peer.connect("ws://localhost")).toThrow("closed")
  })

  it("borrows a supplied signer without freeing it", async () => {
    const signer = MemorySigner.generate()
    const free = vi.spyOn(signer, "free")
    const peer = create({ signer })
    try {
      await peer.close()
      expect(free).not.toHaveBeenCalled()
      expect(await signer.sign(new Uint8Array([1]))).toHaveLength(64)
    } finally {
      signer.free()
    }
  })

  it("starts configured servers immediately and allows duplicate URLs", async () => {
    openTransport.mockRejectedValue(new Error("offline"))
    const peer = create({
      servers: ["ws://localhost", "ws://localhost"],
      retry: false,
    })
    await Promise.all(peer.connections.map(c => c.connected().catch(() => {})))
    expect(peer.connections).toHaveLength(2)
    expect(openTransport).toHaveBeenCalledTimes(2)
    const added = peer.connect("ws://localhost")
    expect(peer.connections[2]).toBe(added)
    await expect(added.connected()).rejects.toThrow("offline")
    expect(openTransport).toHaveBeenCalledTimes(3)
  })

  it("closes connections before the backend, then releases the owned signer", async () => {
    openTransport.mockRejectedValue(new Error("offline"))
    const generated = vi.spyOn(MemorySigner, "generate")
    const peer = create({ servers: ["ws://localhost"], retry: false })
    await expect(peer.connections[0].connected()).rejects.toThrow("offline")
    const order: string[] = []
    const connection = peer.connections[0]
    const closeConnection = connection.close.bind(connection)
    vi.spyOn(connection, "close").mockImplementation(async () => {
      order.push("connection")
      await closeConnection()
    })
    const closeBackend = peer.backend.close.bind(peer.backend)
    vi.spyOn(peer.backend, "close").mockImplementation(async () => {
      order.push("backend")
      await closeBackend()
    })
    const signer = generated.mock.results[0].value as MemorySigner
    const freeSigner = signer.free.bind(signer)
    vi.spyOn(signer, "free").mockImplementation(() => {
      order.push("signer")
      freeSigner()
    })
    await peer[Symbol.asyncDispose]()
    expect(order).toEqual(["connection", "backend", "signer"])
  })

  it("still closes the backend and frees its signer after a connection close failure", async () => {
    const generated = vi.spyOn(MemorySigner, "generate")
    const peer = create()
    const connection = peer.connect("ws://localhost")
    openTransport.mockRejectedValue(new Error("offline"))
    const actualClose = connection.close.bind(connection)
    vi.spyOn(connection, "close").mockImplementation(async () => {
      await actualClose()
      throw new Error("cleanup failure")
    })
    const closeBackend = vi.spyOn(peer.backend, "close")
    const free = vi.spyOn(
      generated.mock.results[0].value as MemorySigner,
      "free"
    )
    await expect(peer.close()).rejects.toThrow("close failed")
    expect(closeBackend).toHaveBeenCalledOnce()
    expect(free).toHaveBeenCalledOnce()
  })

  it("cleans up a partially constructed peer after server validation fails", async () => {
    const generated = vi.spyOn(MemorySigner, "generate")
    let free: ReturnType<typeof vi.spyOn> | undefined
    const servers: SubductionServer[] = [
      "ws://localhost",
      {
        get url() {
          free = vi.spyOn(
            generated.mock.results[0].value as MemorySigner,
            "free"
          )
          return "https://localhost"
        },
      },
    ]
    expect(() => createSubductionPeer({ servers })).toThrow("ws:")
    await vi.waitFor(() => expect(free).toHaveBeenCalledOnce())
    expect(openTransport).not.toHaveBeenCalled()
  })
})
