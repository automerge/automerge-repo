import * as N from "@automerge/subduction"
import { Repo } from "@automerge/automerge-repo"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createSubductionPeer,
  SubductionBackend,
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

  it("creates an immediately usable local Repo with a generated signer", async () => {
    const peer = create()
    expect(peer.peerId).toMatch(/^[0-9a-f]{64}$/)
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
    const closing = peer.close()
    expect(peer.close()).toBe(closing)
    await closing
    expect(() => peer.connect("ws://localhost")).toThrow("closed")
  })

  it("derives the peer ID from a supplied signer", async () => {
    const signer = N.createMemorySigner()
    const peer = create({ signer })
    expect(peer.peerId).toBe(signer.peerId())
    await peer.close()
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

  it("closes connections before the backend", async () => {
    openTransport.mockRejectedValue(new Error("offline"))
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
    await peer[Symbol.asyncDispose]()
    expect(order).toEqual(["connection", "backend"])
  })

  it("still closes the backend after a connection close failure", async () => {
    const peer = create()
    const connection = peer.connect("ws://localhost")
    openTransport.mockRejectedValue(new Error("offline"))
    const actualClose = connection.close.bind(connection)
    vi.spyOn(connection, "close").mockImplementation(async () => {
      await actualClose()
      throw new Error("cleanup failure")
    })
    const closeBackend = vi.spyOn(peer.backend, "close")
    await expect(peer.close()).rejects.toThrow("close failed")
    expect(closeBackend).toHaveBeenCalledOnce()
  })

  it("cleans up a partially constructed peer after server validation fails", async () => {
    const close = vi.spyOn(SubductionBackend.prototype, "close")
    const servers: SubductionServer[] = [
      "ws://localhost",
      { url: "https://localhost" },
    ]
    expect(() => createSubductionPeer({ servers })).toThrow("ws:")
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(openTransport).not.toHaveBeenCalled()
  })
})
