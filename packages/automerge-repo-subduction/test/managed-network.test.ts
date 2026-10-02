import * as N from "@automerge/subduction"
import { Repo } from "@automerge/automerge-repo"
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree"
import { expect, it, vi } from "vitest"
import {
  createSubductionPeer,
  MemoryByteStore,
  SubductionBackend,
} from "../src/index.js"
import { PairedTransport } from "./transport.js"

const { openTransport } = vi.hoisted(() => ({ openTransport: vi.fn() }))
vi.mock("../src/websocket.js", () => ({ openTransport }))

function connectTo(
  remoteSigner: N.MemorySigner,
  remoteBackend: SubductionBackend
) {
  const wires: PairedTransport[] = []
  openTransport
    .mockReset()
    .mockImplementation(async (_url, signer, service, signal, disconnect) => {
      const [a, b] = PairedTransport.pair()
      wires.push(a)
      const abort = () => {
        void a.disconnect()
      }
      signal.addEventListener("abort", abort, { once: true })
      a.onDisconnect(() => {
        signal.removeEventListener("abort", abort)
        disconnect(new Error("Test wire disconnected"))
      })
      // Subduction supports simultaneous initiation, including discovery mode.
      const [local, remote] = await Promise.all([
        N.AuthenticatedTransport.setupDiscover(a, signer, service),
        N.AuthenticatedTransport.setupDiscover(b, remoteSigner, service),
      ])
      try {
        await remoteBackend.addConnection(remote)
      } finally {
        remote.free()
      }
      return local
    })
  return wires
}

it("syncs through real native handshakes and reconnects after deleteLocal resets the engine", async () => {
  const remoteSigner = N.MemorySigner.generate()
  const remoteBackend = new SubductionBackend({
    signer: remoteSigner,
    storage: new MemoryByteStore(),
  })
  const wires = connectTo(remoteSigner, remoteBackend)
  const peer = createSubductionPeer({
    servers: ["ws://localhost:8080"],
    retry: { initialMs: 10, maxMs: 50 },
  })
  const localRepo = new Repo({ backend: peer.backend })
  const remoteRepo = new Repo({ backend: remoteBackend })
  try {
    await peer.connections[0].connected()
    const handle = await localRepo.create({ count: 0 })
    const remoteHandle = await remoteRepo.find<{ count: number }>(
      handle.documentId
    )
    await peer.backend.deleteLocal(sedimentreeId("73".repeat(16)))
    await vi.waitFor(
      () => {
        expect(openTransport.mock.calls.length).toBeGreaterThanOrEqual(2)
        expect(peer.connections[0].status).toBe("connected")
      },
      { timeout: 10_000 }
    )
    await handle.change(doc => {
      doc.count++
    })
    await vi.waitFor(
      () => {
        expect(remoteHandle.doc()!.count).toBe(1)
      },
      { timeout: 10_000 }
    )
    await localRepo.shutdown()
    await peer.backend.close()
    expect(peer.connections[0].status).toBe("closed")
  } finally {
    await Promise.all([localRepo.shutdown(), remoteRepo.shutdown()])
    await peer.close()
    await remoteBackend.close()
    await Promise.all(wires.map(wire => wire.disconnect()))
    remoteSigner.free()
  }
}, 30_000)

it("retries onboarding superseded by deletion without treating the backend as closed", async () => {
  const remoteSigner = N.MemorySigner.generate()
  const remoteBackend = new SubductionBackend({
    signer: remoteSigner,
    storage: new MemoryByteStore(),
  })
  const wires = connectTo(remoteSigner, remoteBackend)
  const storage = new MemoryByteStore()
  let release!: () => void
  let enter!: () => void
  const paused = new Promise<void>(resolve => {
    release = resolve
  })
  const entered = new Promise<void>(resolve => {
    enter = resolve
  })
  vi.spyOn(storage, "list").mockImplementationOnce(async () => {
    enter()
    await paused
    return []
  })
  const peer = createSubductionPeer({
    storage,
    servers: ["ws://localhost:8080"],
    retry: { initialMs: 10, maxMs: 50 },
  })
  try {
    const ready = peer.connections[0].connected()
    await entered
    const deleting = peer.backend.deleteLocal(sedimentreeId("73".repeat(16)))
    release()
    await deleting
    await ready
    expect(openTransport.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(peer.connections[0].status).toBe("connected")
    await expect(peer.backend.flush()).resolves.toBeUndefined()
  } finally {
    release()
    await peer.close()
    await remoteBackend.close()
    await Promise.all(wires.map(wire => wire.disconnect()))
    remoteSigner.free()
  }
}, 30_000)
