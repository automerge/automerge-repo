// Fullfat initializes the native runtime borrowed by the backend's slim import.
import * as N from "@automerge/subduction"
import { Repo, generateAutomergeUrl } from "@automerge/automerge-repo"
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SubductionBackend,
  type SubductionConnect,
  type SubductionNetworkAdapterInterface,
} from "../src/index.js"
import { runSubductionNetworkAdapterTests } from "../src/helpers/tests/subduction-network-adapter-tests.js"
import { DummySubductionStorageAdapter } from "../src/helpers/DummySubductionStorageAdapter.js"
import { PairedTransport } from "./transport.js"
import { deferred } from "./storage.js"

const serviceName = "linked.test"

/** Dials `remote` in-process once `hold` resolves; no reconnection. */
class LinkedAdapter implements SubductionNetworkAdapterInterface {
  readonly wires: PairedTransport[] = []
  private stopped = deferred()
  private isStopped = false
  constructor(
    private readonly remote?: SubductionBackend,
    private readonly hold?: Promise<void>
  ) {}
  async start(connect: SubductionConnect): Promise<void> {
    await Promise.race([this.hold, this.stopped.promise])
    if (this.isStopped) throw new Error("Adapter stopped")
    if (!this.remote) throw new Error("Remote unreachable")
    const [local, remote] = PairedTransport.pair()
    this.wires.push(local)
    void this.remote.acceptConnection(remote, { serviceName }).catch(() => {})
    await connect(local, { serviceName })
  }
  async stop(): Promise<void> {
    this.isStopped = true
    this.stopped.resolve()
    await Promise.all(this.wires.map(wire => wire.disconnect()))
  }
}

function backend(network?: SubductionNetworkAdapterInterface[]) {
  return new SubductionBackend({
    storage: new DummySubductionStorageAdapter(),
    network,
    syncTimeoutMilliseconds: 1000,
  })
}

describe("LinkedAdapter", () => {
  let remote: SubductionBackend
  runSubductionNetworkAdapterTests(async () => {
    remote = backend()
    return {
      adapter: new LinkedAdapter(remote),
      teardown: () => remote.close(),
    }
  }, "LinkedAdapter")
})

describe("backend-owned network adapters", () => {
  const cleanup: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step()
    vi.restoreAllMocks()
  })
  function repo(b: SubductionBackend) {
    const r = new Repo({ backend: b })
    cleanup.push(async () => {
      await r.shutdown()
      await b.close()
    })
    return r
  }

  it("defaults the signer and exposes its peer ID", () => {
    const signer = N.createMemorySigner()
    const supplied = new SubductionBackend({
      storage: new DummySubductionStorageAdapter(),
      signer,
    })
    const generated = backend()
    cleanup.push(() => supplied.close())
    cleanup.push(() => generated.close())
    expect(supplied.peerId).toBe(signer.peerId())
    expect(generated.peerId).toMatch(/^[0-9a-f]{64}$/)
    expect(generated.peerId).not.toBe(supplied.peerId)
  })

  it("finds a document from a server that connects after the lookup", async () => {
    const remote = backend()
    const remoteRepo = repo(remote)
    const source = await remoteRepo.create({ count: 1 })
    await remoteRepo.flush()
    const hold = deferred()
    const localRepo = repo(backend([new LinkedAdapter(remote, hold.promise)]))
    let settled = false
    const found = localRepo.find<{ count: number }>(source.url).finally(() => {
      settled = true
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    hold.resolve()
    expect((await found).doc()).toEqual({ count: 1 })
  }, 10_000)

  it("reports a document unavailable once an unreachable adapter has failed", async () => {
    const hold = deferred()
    const localRepo = repo(
      backend([new LinkedAdapter(undefined, hold.promise)])
    )
    let settled = false
    const found = localRepo.find(generateAutomergeUrl()).finally(() => {
      settled = true
    })
    void found.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    hold.resolve()
    await expect(found).rejects.toThrow("unavailable")
  })

  it("reports a document unavailable at once without adapters", async () => {
    const localRepo = repo(backend())
    await expect(localRepo.find(generateAutomergeUrl())).rejects.toThrow(
      "unavailable"
    )
  })

  it("does not wait again after a settled adapter disconnects", async () => {
    const remote = backend()
    repo(remote)
    const adapter = new LinkedAdapter(remote)
    const local = backend([adapter])
    const localRepo = repo(local)
    const engine = (local as unknown as { engine: N.Subduction }).engine
    await vi.waitFor(async () =>
      expect(await engine.getConnectedPeerIds()).toHaveLength(1)
    )
    await adapter.wires[0].disconnect()
    await vi.waitFor(async () =>
      expect(await engine.getConnectedPeerIds()).toHaveLength(0)
    )
    await expect(localRepo.find(generateAutomergeUrl())).rejects.toThrow(
      "unavailable"
    )
  })

  it("stops its adapters on close and reports stop failures", async () => {
    const adapter = new LinkedAdapter()
    const stop = vi
      .spyOn(adapter, "stop")
      .mockRejectedValueOnce(new Error("stop failed"))
    const b = backend([adapter])
    const closing = b.close()
    expect(b.close()).toBe(closing)
    await expect(closing).rejects.toThrow("close failed")
    expect(stop).toHaveBeenCalledOnce()
  })

  it("unblocks pending lookups when closed while an adapter is connecting", async () => {
    const adapter: SubductionNetworkAdapterInterface = {
      start: () => new Promise(() => {}),
      stop: async () => {},
    }
    const b = backend([adapter])
    const session = b.open(sedimentreeId("72".repeat(16) + "00".repeat(16)))
    const events = (async () => {
      for await (const _ of session.events);
    })()
    await new Promise(resolve => setTimeout(resolve, 20))
    await b.close()
    await events
  })
})
