import * as N from "@automerge/subduction"
import { Repo } from "@automerge/automerge-repo"
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree"
import { SubductionBackend } from "@automerge/automerge-repo-subduction"
import { DummySubductionStorageAdapter } from "@automerge/automerge-repo-subduction/helpers/DummySubductionStorageAdapter.js"
import { expect, it, vi } from "vitest"
import { WebSocketSubductionNetworkAdapter } from "../src/index.js"
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
  const adapter = new WebSocketSubductionNetworkAdapter("ws://localhost:8080", {
    retry: { initialMs: 10, maxMs: 50 },
  })
  const local = new SubductionBackend({
    storage: new DummySubductionStorageAdapter(),
    network: [adapter],
  })
  const localRepo = new Repo({ backend: local })
  const remoteRepo = new Repo({ backend: remoteBackend })
  try {
    await adapter.connected()
    const handle = await localRepo.create({ count: 0 })
    const remoteHandle = await remoteRepo.find<{ count: number }>(
      handle.documentId
    )
    await local.deleteLocal(sedimentreeId("73".repeat(16) + "00".repeat(16)))
    expect(openTransport).toHaveBeenCalledOnce()
    expect(adapter.status).toBe("connected")
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
    await local.close()
    expect(adapter.status).toBe("closed")
  } finally {
    await Promise.all([localRepo.shutdown(), remoteRepo.shutdown()])
    await local.close()
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
  // The backend starts its adapter on construction; pause onboarding first.
  const add = SubductionBackend.prototype.addConnection
  vi.spyOn(SubductionBackend.prototype, "addConnection").mockImplementationOnce(
    async function (this: SubductionBackend, transport, audience) {
      enter()
      await paused
      return add.call(this, transport, audience)
    }
  )
  const adapter = new WebSocketSubductionNetworkAdapter("ws://localhost:8080", {
    retry: { initialMs: 10, maxMs: 50 },
  })
  const local = new SubductionBackend({ storage, network: [adapter] })
  try {
    const ready = adapter.connected()
    await entered
    const deleting = local.deleteLocal(
      sedimentreeId("73".repeat(16) + "00".repeat(16))
    )
    release()
    await deleting
    await ready
    expect(openTransport).toHaveBeenCalledOnce()
    expect(adapter.status).toBe("connected")
    await expect(local.flush()).resolves.toBeUndefined()
  } finally {
    release()
    await local.close()
    await remoteBackend.close()
    await Promise.all(wires.map(wire => wire.disconnect()))
  }
}, 30_000)
