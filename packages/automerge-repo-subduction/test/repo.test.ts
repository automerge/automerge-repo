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
import { SubductionBackend } from "../src/index.js"
import { TestStore, deferred } from "./storage.js"
import { corruptFrame } from "./frame.js"
import { repoFragmentFixture } from "./repoFixture.js"
import { RepoTransport } from "./repoTransport.js"
import { connectBackends, type TestSigner } from "./transport.js"

type State = { count: number; left?: number; right?: number }
type Peer = {
  repo: Repo
  backend: SubductionBackend
  storage: TestStore
  signer: TestSigner
}
const wait = { timeout: 8000, interval: 20 }
// A commit whose hash starts with a zero byte is a boundary, so creation can
// store and sync history as a fragment rather than loose commits.
const isRecordKey = (key: string) => /\/(commits|fragments)\//.test(key)
const fragmentKeys = async (p: Peer) =>
  (await p.storage.list("subduction-v2/")).filter(key =>
    key.includes("/fragments/")
  )

async function ready<T>(handle: DocHandle<T>, state: T) {
  await vi.waitFor(() => expect(handle.doc()).toEqual(state), wait)
}

describe("public Repo with native Subduction", () => {
  const peers: Peer[] = []
  const wires: RepoTransport[] = []
  const gates: ReturnType<typeof deferred>[] = []

  function peer(storage?: TestStore): Peer {
    const signer = N.createMemorySigner(
      new Uint8Array(32).fill(peers.length + 1)
    )
    const disk = storage ?? new TestStore()
    const backend = new SubductionBackend({
      storage: disk,
      signer,
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
    await connectBackends(a, b, pair)
    return pair
  }

  function failAfterLocalScan(p: Peer, failures: number): () => number {
    const engine = (p.backend as unknown as { engine: N.Subduction }).engine
    const nativeLoad = engine.loadAndWatch.bind(engine)
    let openings = 0
    vi.spyOn(engine, "loadAndWatch").mockImplementation((...args) => {
      const updates = nativeLoad(...args)
      if (++openings > failures) return updates
      let checked = false
      return {
        async next() {
          if (checked) throw new Error("injected native stream storage error")
          const next = await updates.next()
          if (next.value?.type === "storageChecked") checked = true
          return next
        },
        [Symbol.asyncIterator]() {
          return this
        },
        close() {
          updates.close()
        },
      }
    })
    return () => openings
  }

  afterEach(async () => {
    gates.splice(0).forEach(gate => gate.resolve())
    await Promise.allSettled(wires.splice(0).map(wire => wire.disconnect()))
    await Promise.allSettled(peers.map(p => p.repo.shutdown()))
    await Promise.allSettled(peers.splice(0).map(p => p.backend.close()))
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
    const keys = await b.storage.list("subduction-v2/")
    expect(keys.some(key => key.includes("/fragments/"))).toBe(true)
    expect(keys.some(key => key.includes("/commits/"))).toBe(true)
    await wires[0].disconnect()
    await b.repo.shutdown()
    const reloaded = await peer(b.storage).repo.find<State>(source.url)
    expect(reloaded.doc()).toEqual({ count: 1999 })
    expect(A.getAllChanges(reloaded.fullDoc())).toHaveLength(2000)
    expect(A.getHeads(reloaded.fullDoc())).toEqual(A.getHeads(fixture))
  }, 60000)

  it("syncs boundary edits stored loose, then their compacted fragments, and reloads from either", async () => {
    const a = peer(),
      b = peer()
    const source = await a.repo.create<State>({ count: 0 })
    await connect(a, b)
    const receiver = await b.repo.find<State>(source.url)
    await ready(receiver, { count: 0 })
    const created = await fragmentKeys(a)
    let boundaries = 0
    while (boundaries < 2) {
      await source.change(doc => {
        doc.count++
      })
      if (A.getHeads(source.fullDoc())[0].startsWith("00")) boundaries++
    }
    const count = source.doc()!.count
    // Loose commits sync before any compaction.
    await ready(receiver, { count })
    expect(await fragmentKeys(a)).toEqual(created)
    await Promise.all([a.repo.flush(), b.repo.flush()])
    for (const p of [a, b])
      expect(
        (await p.storage.list("subduction-v2/")).some(key =>
          key.includes("/fragments/")
        )
      ).toBe(true)
    await wires[0].disconnect()
    for (const p of [a, b]) {
      await p.repo.shutdown()
      const reloaded = await peer(p.storage).repo.find<State>(source.url)
      expect(reloaded.doc()).toEqual({ count })
      expect(A.getHeads(reloaded.fullDoc())).toEqual(
        A.getHeads(source.fullDoc())
      )
    }
  }, 60000)

  it("pushes single edits and a single compacted fragment without sync rounds", async () => {
    const a = peer(),
      b = peer()
    const source = await a.repo.create<State>({ count: 0 })
    await connect(a, b)
    const receiver = await b.repo.find<State>(source.url)
    await ready(receiver, { count: 0 })
    const engine = (a.backend as unknown as { engine: N.Subduction }).engine
    const rounds = vi.spyOn(engine, "syncWithAllPeers")
    const pushedFragments = vi.spyOn(engine, "addFragment")
    // Edit until exactly one boundary commit is due for compaction.
    do
      await source.change(doc => {
        doc.count++
      })
    while (!A.getHeads(source.fullDoc())[0].startsWith("00"))
    const count = source.doc()!.count
    await ready(receiver, { count })
    await a.repo.flush()
    expect(pushedFragments).toHaveBeenCalledOnce()
    await vi.waitFor(async () => {
      expect(
        (await b.storage.list("subduction-v2/")).some(key =>
          key.includes("/fragments/")
        )
      ).toBe(true)
    }, wait)
    expect(rounds).not.toHaveBeenCalled()
    await b.repo.shutdown()
    const reloaded = await peer(b.storage).repo.find<State>(source.url)
    expect(A.getHeads(reloaded.fullDoc())).toEqual(A.getHeads(source.fullDoc()))
  }, 60000)

  it("propagates an import into an existing document with one sync round", async () => {
    const a = peer(),
      b = peer()
    const source = await a.repo.create<State>({ count: 0 })
    await connect(a, b)
    const receiver = await b.repo.find<State>(source.url)
    await ready(receiver, { count: 0 })
    let fork = A.clone(source.fullDoc())
    for (let i = 1; i <= 3; i++)
      fork = A.change(fork, doc => {
        doc.left = i
      })
    const engine = (a.backend as unknown as { engine: N.Subduction }).engine
    const rounds = vi.spyOn(engine, "syncWithAllPeers")
    const { documentId } = parseAutomergeUrl(source.url)
    await a.repo.import<State>(A.save(fork), { docId: documentId })
    await ready(receiver, { count: 0, left: 3 })
    expect(rounds).toHaveBeenCalledOnce()
  }, 20000)

  it("syncs a boundary left loose by a crash alongside a later compacted fragment", async () => {
    // A crash before compaction leaves boundary F loose. After reopening,
    // the next boundary H is compacted into a fragment whose boundary is F.
    // Native must still send F: it is not part of H's payload.
    const a = peer()
    const source = await a.repo.create<State>({ count: 0 })
    const url = source.url
    await source.change(doc => {
      doc.count++
    })
    while (!A.getHeads(source.fullDoc())[0].startsWith("00"))
      await source.change(doc => {
        doc.count++
      })
    // Crash: drop the Repo without flush or shutdown.
    await a.backend.close()
    const reopened = peer(a.storage)
    const again = await reopened.repo.find<State>(url)
    while (!A.getHeads(again.fullDoc())[0].startsWith("00"))
      await again.change(doc => {
        doc.count++
      })
    await reopened.repo.flush()
    const count = again.doc()!.count
    const b = peer()
    await connect(reopened, b)
    const receiver = await b.repo.find<State>(url)
    await ready(receiver, { count })
    expect(A.getMissingDeps(receiver.fullDoc(), [])).toEqual([])
    expect(A.getHeads(receiver.fullDoc())).toEqual(A.getHeads(again.fullDoc()))
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

  it("rejects a persisted commit blob corrupted on disk via native hydration", async () => {
    const p = peer()
    const handle = await p.repo.create<State>({ count: 0 })
    handle.change(doc => {
      doc.count = 1
    })
    await p.repo.flush()
    await p.repo.shutdown()
    // Native hydration verifies every blob digest on open (see fragments.test.ts).
    const key = (await p.storage.list("subduction-v2/")).find(k =>
      k.includes("/commits/blob/")
    )!
    await p.storage.save(
      key,
      corruptFrame((await p.storage.load(key))!, "blob")
    )
    const restarted = peer(p.storage)
    // The corruption surfaces as the lookup's failure, not as absence.
    await expect(restarted.repo.find(handle.url)).rejects.toThrow(
      /blob mismatch/
    )
  })

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
      await handle.changeAt(oldHeads, doc => {
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
    expect(peer(p.storage).repo.query(handle.url).state().state).toBe("loading")
  })

  it("deletes unopened stored history without opening a native stream", async () => {
    const writer = peer()
    const handle = await writer.repo.create<State>({ count: 0 })
    await writer.repo.flush()
    await writer.repo.shutdown()
    const p = peer(writer.storage)
    const engine = (p.backend as unknown as { engine: N.Subduction }).engine
    const watch = vi.spyOn(engine, "loadAndWatch")
    const open = vi.spyOn(p.backend, "open")
    await p.repo.delete(handle.url)
    expect(open).not.toHaveBeenCalled()
    expect(watch).not.toHaveBeenCalled()
    await p.repo.shutdown()
    await expect(peer(p.storage).repo.find(handle.url)).rejects.toThrow(
      "unavailable"
    )
  })

  it("reports storage failure from change, but shutdown is best effort", async () => {
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
    await expect(p.repo.shutdown()).resolves.toBeUndefined()
  })

  it("flush reports an earlier storage failure", async () => {
    const p = peer()
    const handle = await p.repo.create<State>({ count: 0 })
    p.storage.beforeSave = async () => {
      throw new Error("Disk unavailable")
    }
    await handle
      .change(doc => {
        doc.count = 1
      })
      .catch(() => {})
    await expect(p.repo.flush()).rejects.toThrow()
  })

  it("reloads acknowledged history after a failed fragmented merge", async () => {
    const p = peer()
    const handle = await p.repo.create<State>({ count: 0 })
    let fork = A.clone(handle.fullDoc())
    for (let count = 1; count <= 2000; count++)
      fork = A.change(fork, { time: 0 }, doc => {
        doc.count = count
      })
    // The merge stores commits and fragments in one batch; fail it at its
    // first fragment, after the commits were checked.
    p.storage.beforeSave = async key => {
      if (key.includes("/fragments/")) throw new Error("Disk unavailable")
    }
    const forked = await new Repo().import<State>(A.save(fork))
    await expect(handle.merge(forked)).rejects.toThrow()
    await p.repo.shutdown()
    p.storage.beforeSave = undefined
    // A partially stored batch would leave commits whose parents never
    // arrive: the marker could never be satisfied and find would hang.
    const reloaded = await Promise.race([
      peer(p.storage).repo.find<State>(handle.url),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("find did not settle")), 3000)
      ),
    ])
    expect(reloaded.doc()).toEqual({ count: 0 })
  })

  it("reports an absent document unavailable when the connected peer lacks it, then recovers", async () => {
    const a = peer(),
      b = peer()
    await connect(a, b)
    const url = generateAutomergeUrl()
    const progress = b.repo.query(url)
    await expect(b.repo.find(url)).rejects.toThrow("unavailable")
    expect(progress.state().state).toBe("unavailable")
    const { documentId } = parseAutomergeUrl(url)
    await a.repo.import<State>(A.save(A.from<State>({ count: 9 })), {
      docId: documentId,
    })
    await vi.waitFor(() => expect(progress.state().state).toBe("ready"), wait)
    expect((await b.repo.find<State>(url)).doc()).toEqual({ count: 9 })
  }, 10000)

  it("reports an absent document unavailable when the only peer fails its round", async () => {
    const a = peer(),
      b = peer()
    await connect(a, b)
    const engine = (b.backend as unknown as { engine: N.Subduction }).engine
    const sync = engine.syncWithAllPeers.bind(engine)
    vi.spyOn(engine, "syncWithAllPeers").mockImplementation(async (...args) => {
      const results = await sync(...args)
      for (const response of Object.values(results)) response.success = false
      return results
    })
    const url = generateAutomergeUrl()
    await expect(b.repo.find(url)).rejects.toThrow("unavailable")
  }, 10000)

  it("still finds a present document after the empty-load round", async () => {
    const a = peer(),
      b = peer()
    const source = await a.repo.create<State>({ count: 2 })
    await a.repo.flush()
    await connect(a, b)
    const progress = b.repo.query<State>(source.url)
    const states: string[] = [progress.state().state]
    const unsubscribe = progress.subscribe(state => states.push(state.state))
    try {
      expect((await b.repo.find<State>(source.url)).doc()).toEqual({
        count: 2,
      })
      expect(states).not.toContain("unavailable")
    } finally {
      unsubscribe()
    }
  }, 10000)

  it("loads a missing document from a peer with one explicit round", async () => {
    const a = peer(),
      b = peer()
    const source = await a.repo.create<State>({ count: 3 })
    await a.repo.flush()
    await connect(a, b)
    const engine = (b.backend as unknown as { engine: N.Subduction }).engine
    const rounds = vi.spyOn(engine, "syncWithAllPeers")
    const receiver = await b.repo.find<State>(source.url)
    expect(receiver.doc()).toEqual({ count: 3 })
    // loadAndWatch fetched and subscribed; later edits still arrive.
    await source.change(doc => {
      doc.count = 4
    })
    await ready(receiver, { count: 4 })
    // Only the empty-load round; loadAndWatch supplies the data and updates.
    expect(rounds).toHaveBeenCalledOnce()
  }, 10000)

  it("returns stale local history immediately, then catches up from a peer", async () => {
    const a = peer(),
      b = peer()
    const source = await a.repo.create<State>({ count: 1 })
    const old = A.clone(source.fullDoc())
    await source.change(doc => {
      doc.count = 2
    })
    await a.repo.flush()
    const { documentId } = parseAutomergeUrl(source.url)
    await b.repo.import<State>(A.save(old), { docId: documentId })
    await b.repo.flush()
    await b.repo.shutdown()
    const reader = peer(b.storage)
    await connect(a, reader)
    const engine = (reader.backend as unknown as { engine: N.Subduction })
      .engine
    const rounds = vi.spyOn(engine, "syncWithAllPeers")
    const loaded = await reader.repo.find<State>(source.url)
    expect(loaded.doc()?.count).toBeGreaterThanOrEqual(1)
    await ready(loaded, { count: 2 })
    expect(A.getHeads(loaded.fullDoc())).toEqual(A.getHeads(source.fullDoc()))
    expect(rounds).not.toHaveBeenCalled()
  }, 10000)

  it("fails the handle when the native stream errors after loading", async () => {
    const original = peer()
    const source = await original.repo.create<State>({ count: 0 })
    await original.repo.flush()
    await original.repo.shutdown()
    const reader = peer(original.storage)
    const openings = failAfterLocalScan(reader, 1)
    const progress = reader.repo.query<State>(source.url)
    await vi.waitFor(() => expect(progress.state().state).toBe("failed"), wait)
    expect(openings()).toBe(1)
  }, 15000)

  it("finds a document whose only peer connects after the lookup started", async () => {
    const a = peer(),
      b = peer()
    const source = await a.repo.create<State>({ count: 5 })
    await a.repo.flush()
    const progress = b.repo.query<State>(source.url)
    await vi.waitFor(
      () => expect(progress.state().state).not.toBe("loading"),
      wait
    )
    await connect(a, b)
    await vi.waitFor(() => expect(progress.state().state).toBe("ready"), wait)
    expect((await b.repo.find<State>(source.url)).doc()).toEqual({ count: 5 })
  }, 10000)

  it("does not mark a late peer's partial history ready", async () => {
    const a = peer(),
      b = peer()
    const source = await a.repo.create<State>({ count: 0 })
    await source.change(doc => {
      doc.count = 1
    })
    await a.repo.flush()
    const progress = b.repo.query<State>(source.url)
    await vi.waitFor(
      () => expect(progress.state().state).toBe("unavailable"),
      wait
    )
    const entered = deferred(),
      gate = deferred()
    gates.push(gate)
    let writes = 0
    b.storage.beforeSave = async key => {
      if (isRecordKey(key) && ++writes === 2) {
        entered.resolve()
        await gate.promise
      }
    }
    try {
      await connect(a, b)
      await entered.promise
      expect(progress.state().state).not.toBe("ready")
      gate.resolve()
      await vi.waitFor(() => expect(progress.state().state).toBe("ready"), wait)
      expect((await b.repo.find<State>(source.url)).doc()).toEqual({ count: 1 })
    } finally {
      gate.resolve()
    }
  }, 10000)

  it("waits for delayed incoming history without reporting unavailable", async () => {
    const a = peer(),
      b = peer()
    const source = await a.repo.create<State>({ count: 7 })
    const entered = deferred(),
      gate = deferred()
    gates.push(gate)
    b.storage.beforeSave = async key => {
      if (isRecordKey(key)) {
        entered.resolve()
        await gate.promise
      }
    }
    await connect(a, b)
    const progress = b.repo.query<State>(source.url)
    const states: string[] = [progress.state().state]
    const unsubscribe = progress.subscribe(state => states.push(state.state))
    const finding = b.repo.find<State>(source.url)
    void finding.catch(() => {})
    try {
      await entered.promise
      expect(progress.state().state).toBe("loading")
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
