import * as N from "@automerge/subduction"
import { Repo } from "@automerge/automerge-repo"
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree"
import { expect, it, vi } from "vitest"
import { createSubductionPeer, SubductionBackend } from "../src/index.js"
import { DummySubductionStorageAdapter } from "../src/helpers/DummySubductionStorageAdapter.js"
import { PairedTransport } from "./transport.js"

const { openTransport } = vi.hoisted(() => ({ openTransport: vi.fn() }))
vi.mock("../src/websocket.js", () => ({ openTransport }))

function connectTo(remoteBackend: SubductionBackend) {
  const wires: PairedTransport[] = []
  openTransport
    .mockReset()
    .mockImplementation(async (url: URL, signal, disconnect) => {
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
      // The local peer discovers the remote by the server's service name.
      void remoteBackend
        .acceptConnection(b, { serviceName: url.host })
        .catch(() => {})
      return a
    })
  return wires
}

it("syncs through real native handshakes and keeps the connection across deleteLocal", async () => {
  const remoteBackend = new SubductionBackend({
    signer: N.createMemorySigner(),
    storage: new DummySubductionStorageAdapter(),
  })
  const wires = connectTo(remoteBackend)
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
    expect(openTransport).toHaveBeenCalledOnce()
    expect(peer.connections[0].status).toBe("connected")
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
  }
}, 30_000)

it("completes onboarding while an unrelated deletion runs", async () => {
  const remoteBackend = new SubductionBackend({
    signer: N.createMemorySigner(),
    storage: new DummySubductionStorageAdapter(),
  })
  const wires = connectTo(remoteBackend)
  const storage = new DummySubductionStorageAdapter()
  let release!: () => void
  let enter!: () => void
  const paused = new Promise<void>(resolve => {
    release = resolve
  })
  const entered = new Promise<void>(resolve => {
    enter = resolve
  })
  const peer = createSubductionPeer({
    storage,
    servers: ["ws://localhost:8080"],
    retry: { initialMs: 10, maxMs: 50 },
  })
  const engine = (peer.backend as unknown as { engine: N.Subduction }).engine
  const add = engine.connectTransport.bind(engine)
  vi.spyOn(engine, "connectTransport").mockImplementationOnce(
    async (transport, audience) => {
      enter()
      await paused
      return add(transport, audience)
    }
  )
  try {
    const ready = peer.connections[0].connected()
    await entered
    const deleting = peer.backend.deleteLocal(sedimentreeId("73".repeat(16)))
    release()
    await deleting
    await ready
    expect(openTransport).toHaveBeenCalledOnce()
    expect(peer.connections[0].status).toBe("connected")
    await expect(peer.backend.flush()).resolves.toBeUndefined()
  } finally {
    release()
    await peer.close()
    await remoteBackend.close()
    await Promise.all(wires.map(wire => wire.disconnect()))
  }
}, 30_000)
