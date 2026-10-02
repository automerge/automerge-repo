import * as A from "@automerge/automerge"
// Fullfat initializes the native runtime borrowed by the backend's slim import.
import * as N from "@automerge/subduction"
import {
  Repo,
  generateAutomergeUrl,
  parseAutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SubductionBackend } from "../src/index.js"
import { DiskStore, deferred } from "./storage.js"
import { repoFragmentFixture } from "./repoFixture.js"
import { RepoTransport } from "./repoTransport.js"

type State = { count: number; left?: number; right?: number }
type Peer = {
  repo: Repo
  backend: SubductionBackend
  storage: DiskStore
  signer: N.MemorySigner
}
const wait = { timeout: 8000, interval: 20 }

async function ready<T>(handle: DocHandle<T>, state: T) {
  await vi.waitFor(() => expect(handle.doc()).toEqual(state), wait)
}

describe("public Repo with native Subduction", () => {
  let root: string
  const peers: Peer[] = []
  const wires: RepoTransport[] = []
  const gates: ReturnType<typeof deferred>[] = []

  function peer(storage?: DiskStore): Peer {
    const signer = N.MemorySigner.fromBytes(
      new Uint8Array(32).fill(peers.length + 1)
    )
    const disk = storage ?? new DiskStore(join(root, `peer-${peers.length}`))
    const backend = new SubductionBackend({
      storage: disk,
      signer,
      persistence: "persistent",
      syncTimeoutMilliseconds: 1000,
    })
    const result = {
      repo: new Repo({ backend }),
      backend,
      storage: disk,
      signer,
    }
    peers.push(result)
    return result
  }

  async function connect(a: Peer, b: Peer) {
    const pair = RepoTransport.pair()
    wires.push(...pair)
    const expected = b.signer.peerId()
    const wrappers: N.AuthenticatedTransport[] = []
    const authenticate = async (promise: Promise<N.AuthenticatedTransport>) => {
      try {
        const wrapper = await promise
        wrappers.push(wrapper)
        return wrapper
      } catch (error) {
        await pair[0].disconnect()
        throw error
      }
    }
    try {
      const results = await Promise.allSettled([
        authenticate(
          N.AuthenticatedTransport.setup(pair[0], a.signer, expected)
        ),
        authenticate(N.AuthenticatedTransport.accept(pair[1], b.signer)),
      ])
      const [left, right] = results.map(result => {
        if (result.status === "rejected") throw result.reason
        return result.value
      })
      const added = await Promise.allSettled([
        a.backend.addConnection(left),
        b.backend.addConnection(right),
      ])
      for (const result of added) {
        if (result.status === "rejected") throw result.reason
        expect(result.value).toBe(true)
      }
      return pair
    } catch (error) {
      await pair[0].disconnect()
      throw error
    } finally {
      wrappers.forEach(wrapper => wrapper.free())
      expected.free()
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repo-public-subduction-"))
  })
  afterEach(async () => {
    gates.splice(0).forEach(gate => gate.resolve())
    await Promise.allSettled(wires.splice(0).map(wire => wire.disconnect()))
    await Promise.allSettled(peers.map(p => p.repo.shutdown()))
    await Promise.allSettled(peers.map(p => p.backend.close()))
    peers.splice(0).forEach(p => p.signer.free())
    await rm(root, { recursive: true, force: true })
  }, 20000)

  it("changes state and emits events immediately, but awaits recoverable storage", async () => {
    const p = peer()
    const handle = await p.repo.create<State>({ count: 0 })
    expect(await p.repo.find(handle.url)).toBe(handle)
    const gate = deferred()
    gates.push(gate)
    const saving = deferred()
    p.storage.beforeSave = () => {
      saving.resolve()
      return gate.promise
    }
    const changed = vi.fn()
    handle.on("change", changed)
    let settled = false
    const changing = handle.change(
      doc => {
        doc.count = 1
      },
      { time: 0 }
    )
    void changing.then(
      () => {
        settled = true
      },
      () => {}
    )
    expect(handle.doc()).toEqual({ count: 1 })
    expect(changed).toHaveBeenCalledTimes(1)
    await saving.promise
    expect(settled).toBe(false)
    gate.resolve()
    await changing
    await p.repo.shutdown()
    const reloaded = await peer(p.storage).repo.find<State>(handle.url)
    expect(reloaded.doc()).toEqual({ count: 1 })
  })

  it("flush drains changes started without awaiting their storage promises", async () => {
    const p = peer()
    const handle = await p.repo.create<State>({ count: 0 })
    const gate = deferred(),
      saving = deferred()
    gates.push(gate)
    p.storage.beforeSave = () => {
      saving.resolve()
      return gate.promise
    }
    const first = handle.change(doc => {
      doc.count = 1
    })
    const second = handle.change(doc => {
      doc.left = 10
    })
    let flushed = false
    const flushing = p.repo.flush()
    void flushing.then(
      () => {
        flushed = true
      },
      () => {}
    )
    await saving.promise
    expect(flushed).toBe(false)
    gate.resolve()
    await flushing
    await Promise.all([first, second])
    const heads = A.getHeads(handle.fullDoc())
    await p.repo.shutdown()
    const reloaded = await peer(p.storage).repo.find<State>(handle.url)
    expect(reloaded.doc()).toEqual({ count: 1, left: 10 })
    expect(A.getHeads(reloaded.fullDoc())).toEqual(heads)
  })

  it("syncs a fragmented 2000-change history and recovers it from receiver disk", async () => {
    const a = peer(),
      b = peer()
    const fixture = repoFragmentFixture()
    const source = await a.repo.import<State>(A.save(fixture))
    await a.repo.flush()
    await connect(a, b)
    const receiver = await b.repo.find<State>(source.url)
    await ready(receiver, { count: 1999 })
    await vi.waitFor(() => {
      expect(A.getAllChanges(receiver.fullDoc())).toHaveLength(2000)
      expect(A.getHeads(receiver.fullDoc())).toEqual(A.getHeads(fixture))
    }, wait)
    await b.repo.flush()
    const keys = await b.storage.list("subduction-v1/")
    expect(keys.some(key => key.includes("/fragments/"))).toBe(true)
    expect(keys.some(key => key.includes("/commits/"))).toBe(true)
    await wires[0].disconnect()
    await b.repo.shutdown()
    const reloaded = await peer(b.storage).repo.find<State>(source.url)
    expect(reloaded.doc()).toEqual({ count: 1999 })
    expect(A.getAllChanges(reloaded.fullDoc())).toHaveLength(2000)
    expect(A.getHeads(reloaded.fullDoc())).toEqual(A.getHeads(fixture))
  }, 60000)

  it("syncs bidirectional edits and merges genuinely concurrent edits", async () => {
    const a = peer(),
      b = peer()
    const left = await a.repo.create<State>({ count: 0 })
    const [wireA, wireB] = await connect(a, b)
    const right = await b.repo.find<State>(left.url)
    await ready(right, { count: 0 })
    await left.change(
      doc => {
        doc.count = 1
      },
      { time: 0 }
    )
    await ready(right, { count: 1 })
    await right.change(
      doc => {
        doc.count = 2
      },
      { time: 0 }
    )
    await ready(left, { count: 2 })
    expect(A.getHeads(left.fullDoc())).toEqual(A.getHeads(right.fullDoc()))
    wireA.pause()
    wireB.pause()
    await left.change(
      doc => {
        doc.left = 10
      },
      { time: 0 }
    )
    await right.change(
      doc => {
        doc.right = 20
      },
      { time: 0 }
    )
    expect(A.getHeads(left.fullDoc())).not.toEqual(A.getHeads(right.fullDoc()))
    const mergedHeads = A.getHeads(
      A.merge(A.clone(left.fullDoc()), A.clone(right.fullDoc()))
    )
    wireA.resume()
    wireB.resume()
    await ready(left, { count: 2, left: 10, right: 20 })
    await ready(right, { count: 2, left: 10, right: 20 })
    expect(A.getHeads(left.fullDoc())).toEqual(mergedHeads)
    expect(A.getHeads(right.fullDoc())).toEqual(mergedHeads)
    await Promise.all([a.repo.flush(), b.repo.flush()])
  }, 20000)

  it("merges imports into the same supplied ID and retains the cached handle", async () => {
    const p = peer()
    const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
    const handle = await p.repo.import<State>(
      A.save(A.from<State>({ count: 0 })),
      {
        docId: documentId,
      }
    )
    expect(handle.documentId).toBe(documentId)
    const fork = A.change(
      A.clone(handle.fullDoc(), { actor: "aabbcc" }),
      doc => {
        doc.right = 20
      }
    )
    await handle.change(doc => {
      doc.left = 10
    })
    const imported = await p.repo.import<State>(A.save(fork), {
      docId: handle.documentId,
    })
    expect(imported).toBe(handle)
    expect(imported.documentId).toBe(handle.documentId)
    expect(imported.doc()).toEqual({ count: 0, left: 10, right: 20 })
    expect(
      await p.repo.import<State>(A.save(fork), { docId: handle.documentId })
    ).toBe(handle)
    await p.repo.flush()
    await p.repo.shutdown()
    expect((await peer(p.storage).repo.find<State>(handle.url)).doc()).toEqual({
      count: 0,
      left: 10,
      right: 20,
    })
  })

  it("merges an import with uncached persisted history rather than replacing it", async () => {
    const p = peer()
    const handle = await p.repo.create<State>({ count: 0 })
    const fork = A.change(
      A.clone(handle.fullDoc(), { actor: "ddeeff" }),
      doc => {
        doc.right = 20
      }
    )
    await handle.change(doc => {
      doc.left = 10
    })
    await p.repo.shutdown()
    const restarted = peer(p.storage)
    // No find before import: the supplied ID exists only on disk.
    const imported = await restarted.repo.import<State>(A.save(fork), {
      docId: handle.documentId,
    })
    expect(imported.documentId).toBe(handle.documentId)
    expect(imported.doc()).toEqual({ count: 0, left: 10, right: 20 })
    await restarted.repo.flush()
    await restarted.repo.shutdown()
    expect((await peer(p.storage).repo.find<State>(handle.url)).doc()).toEqual({
      count: 0,
      left: 10,
      right: 20,
    })
  })

  it("reload and repeated flush do not write loaded history back to disk", async () => {
    const p = peer()
    const handle = await p.repo.import(A.save(repoFragmentFixture()))
    await p.repo.flush()
    await p.repo.shutdown()
    const saving = vi.fn(async () => {})
    p.storage.beforeSave = saving
    const restarted = peer(p.storage)
    const reloaded = await restarted.repo.find<{ count: number }>(handle.url)
    expect(reloaded.doc()).toEqual({ count: 1999 })
    await restarted.repo.flush()
    await restarted.repo.flush()
    await restarted.repo.shutdown()
    expect(saving).not.toHaveBeenCalled()
  }, 20000)

  it("retains sub, view, merge, and changeAt on public handles", async () => {
    const p = peer()
    const handle = await p.repo.create<State>({ count: 0 })
    const oldHeads = handle.heads()
    const oldView = handle.view(oldHeads)
    const fork = await p.repo.import<State>(A.save(handle.fullDoc()))
    const count = handle.sub("count")
    const changed = vi.fn()
    count.on("change", changed)
    await count.change(1)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(count.doc()).toBe(1)
    expect(oldView.doc()).toEqual({ count: 0 })
    await fork.change(doc => {
      doc.right = 20
    })
    await handle.merge(fork)
    expect(handle.doc()).toEqual({ count: 1, right: 20 })
    expect(
      handle.changeAt(oldHeads, doc => {
        doc.left = 10
      })
    ).toBeDefined()
    expect(handle.doc()).toEqual({ count: 1, left: 10, right: 20 })
    await p.repo.flush()
    await p.repo.shutdown()
    expect((await peer(p.storage).repo.find<State>(handle.url)).doc()).toEqual({
      count: 1,
      left: 10,
      right: 20,
    })
  })

  it("deletes persisted history and notifies retained root and sub handles", async () => {
    const p = peer()
    const handle = await p.repo.create<State>({ count: 0 })
    const deleted = vi.fn(),
      subDeleted = vi.fn()
    handle.on("delete", deleted)
    handle.sub("count").on("delete", subDeleted)
    await p.repo.delete(handle.url)
    await p.repo.flush()
    expect(deleted).toHaveBeenCalledTimes(1)
    expect(subDeleted).toHaveBeenCalledTimes(1)
    await p.repo.shutdown()
    expect(peer(p.storage).repo.findWithProgress(handle.url).peek().state).toBe(
      "loading"
    )
  })

  it("reports storage failure from change and flush, but shutdown is best effort", async () => {
    const p = peer()
    const handle = await p.repo.create<State>({ count: 0 })
    p.storage.beforeSave = async () => {
      throw new Error("Disk unavailable")
    }
    await expect(
      handle.change(doc => {
        doc.count = 1
      })
    ).rejects.toThrow()
    expect(handle.doc()).toEqual({ count: 1 })
    await expect(p.repo.flush()).rejects.toThrow()
    await expect(p.repo.shutdown()).resolves.toBeUndefined()
  })

  it("keeps an empty connected lookup open for later data", async () => {
    const a = peer(),
      b = peer()
    await connect(a, b)
    const url = generateAutomergeUrl()
    const progress = b.repo.findWithProgress(url)
    expect(progress.peek().state).toBe("loading")
    const { documentId } = parseAutomergeUrl(url)
    await a.repo.import<State>(A.save(A.from<State>({ count: 9 })), {
      docId: documentId,
    })
    await vi.waitFor(async () => {
      expect(
        (await b.storage.list("subduction-v1/")).some(key =>
          key.includes("/commits/")
        )
      ).toBe(true)
    }, wait)
    expect((await b.repo.find<State>(url)).doc()).toEqual({ count: 9 })
  }, 10000)

  it("waits for delayed incoming history without reporting unavailable", async () => {
    const a = peer(),
      b = peer()
    const source = await a.repo.create<State>({ count: 7 })
    const entered = deferred(),
      gate = deferred()
    gates.push(gate)
    b.storage.beforeSave = async key => {
      if (key.includes("/commits/")) {
        entered.resolve()
        await gate.promise
      }
    }
    await connect(a, b)
    const progress = b.repo.findWithProgress<State>(source.url)
    const states: string[] = [progress.peek().state]
    const unsubscribe = progress.subscribe(state => states.push(state.state))
    const finding = progress.whenReady()
    void finding.catch(() => {})
    try {
      await entered.promise
      expect(progress.peek().state).toBe("loading")
      gate.resolve()
      const receiver = await finding
      expect(receiver.doc()).toEqual({ count: 7 })
      expect(states).not.toContain("unavailable")
      expect(states).not.toContain("failed")
    } finally {
      gate.resolve()
      unsubscribe()
    }
  }, 10000)
})
