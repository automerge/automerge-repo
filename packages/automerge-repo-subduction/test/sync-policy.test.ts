import * as A from "@automerge/automerge"
// Fullfat initializes the native runtime borrowed by the backend's slim import.
import * as N from "@automerge/subduction"
import {
  Repo,
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo"
import {
  sedimentreeId,
  type SedimentreeId,
} from "@automerge/automerge-repo/sedimentree"
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SubductionBackend,
  syncAll,
  syncRule,
  type SyncPolicy,
  type SyncRule,
  type SyncRuleSignal,
} from "../src/index.js"
import { SyncRules } from "../src/sync-policy.js"
import { DummySubductionStorageAdapter } from "../src/helpers/DummySubductionStorageAdapter.js"
import { RepoTransport } from "./repoTransport.js"
import { connectBackends, type TestSigner } from "./transport.js"
import { nodeOf } from "./native.js"

type State = { count: number }
const wait = { timeout: 8000, interval: 20 }
const tree = sedimentreeId("a1".repeat(32))
const other = sedimentreeId("a2".repeat(32))
const deny: SyncRule = { access: false, announce: false }
const open = () => true
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Fixed actor and time keep hashes stable and clear of boundaries ("00…"). */
const fixture = (actor: string, count: number) =>
  A.change(A.init<State>({ actor }), { time: 0 }, d => {
    d.count = count
  })

const treeOf = (url: AutomergeUrl): SedimentreeId =>
  sedimentreeId(parseAutomergeUrl(url).binaryDocumentId)

/** One settable signal per document and peer, created on first ask. */
function pairRules(initial: SyncRule = syncAll) {
  const signals = new Map<string, ReturnType<typeof syncRule>>()
  const signal = (doc: SedimentreeId, peer: string) => {
    const key = `${doc}/${peer}`
    let found = signals.get(key)
    if (!found) signals.set(key, (found = syncRule(initial)))
    return found
  }
  return {
    policy: ((doc, peer) => signal(doc, peer)) as SyncPolicy,
    set(doc: SedimentreeId, peer: string, rule: Partial<SyncRule>) {
      const s = signal(doc, peer)
      s.set({ ...s.value, ...rule })
    },
  }
}

describe("syncRule", () => {
  it("notifies on change only, until unsubscribed", () => {
    const rule = syncRule(syncAll)
    const seen = vi.fn()
    const unsubscribe = rule.subscribe(seen)
    rule.set({ access: true, announce: true })
    expect(seen).not.toHaveBeenCalled()
    rule.set(deny)
    expect(rule.value).toEqual(deny)
    expect(seen).toHaveBeenCalledWith(deny)
    unsubscribe()
    rule.set(syncAll)
    expect(seen).toHaveBeenCalledOnce()
  })
})

describe("SyncRules", () => {
  it("allows everything without a policy", () => {
    expect(new SyncRules(undefined, open, () => {}).rule(tree, "peer")).toEqual(
      syncAll
    )
  })

  it("asks once per pair", () => {
    const policy = vi.fn((_doc: SedimentreeId, _peer: string) => syncRule(deny))
    const rules = new SyncRules(policy, open, () => {})
    expect(rules.rule(tree, "peer")).toEqual(deny)
    expect(rules.rule(tree, "peer")).toEqual(deny)
    rules.rule(tree, "other")
    expect(policy.mock.calls).toEqual([
      [tree, "peer"],
      [tree, "other"],
    ])
  })

  it("answers synchronously once an async policy has resolved", async () => {
    const rules = new SyncRules(
      async () => syncRule(deny),
      open,
      () => {}
    )
    const first = rules.rule(tree, "peer")
    expect(first).toBeInstanceOf(Promise)
    expect(await first).toEqual(deny)
    expect(rules.rule(tree, "peer")).toEqual(deny)
  })

  it("asks again after a failed policy call", async () => {
    let calls = 0
    const rules = new SyncRules(
      async () => {
        if (++calls === 1) throw new Error("lookup failed")
        return syncRule(syncAll)
      },
      open,
      () => {}
    )
    await expect(rules.rule(tree, "peer")).rejects.toThrow("lookup failed")
    expect(await rules.rule(tree, "peer")).toEqual(syncAll)
    expect(calls).toBe(2)
  })

  it("reports each pair whose signal becomes announceable", () => {
    const shared = syncRule(deny)
    const announced = vi.fn()
    const rules = new SyncRules(() => shared, open, announced)
    rules.rule(tree, "peer")
    rules.rule(other, "peer")
    shared.set({ access: true, announce: false })
    expect(announced).not.toHaveBeenCalled()
    shared.set(syncAll)
    expect(announced.mock.calls).toEqual([
      [tree, "peer"],
      [other, "peer"],
    ])
  })

  it("ignores a callback made during subscribe", () => {
    const announced = vi.fn()
    const eager: SyncRuleSignal = {
      value: syncAll,
      subscribe(callback) {
        callback(syncAll)
        return () => {}
      },
    }
    new SyncRules(() => eager, open, announced).rule(tree, "peer")
    expect(announced).not.toHaveBeenCalled()
  })

  it("keeps nothing for documents that are not open", () => {
    const subscribe = vi.fn(() => () => {})
    const policy = vi.fn(() => ({ value: deny, subscribe }))
    const rules = new SyncRules(
      policy,
      () => false,
      () => {}
    )
    expect(rules.rule(tree, "peer")).toEqual(deny)
    expect(rules.rule(tree, "peer")).toEqual(deny)
    expect(policy).toHaveBeenCalledTimes(2)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it("forgets a document's pairs and asks again", () => {
    const unsubscribed = vi.fn()
    const policy = vi.fn(() => ({
      value: syncAll,
      subscribe: () => unsubscribed,
    }))
    const rules = new SyncRules(policy, open, () => {})
    rules.rule(tree, "peer")
    rules.rule(other, "peer")
    rules.forgetTree(tree)
    expect(unsubscribed).toHaveBeenCalledOnce()
    rules.rule(tree, "peer")
    rules.rule(other, "peer")
    expect(policy).toHaveBeenCalledTimes(3)
  })

  it("ignores an answer that arrives after the document closed and reopened", async () => {
    const answers: {
      resolve: (signal: SyncRuleSignal) => void
      reject: (cause: unknown) => void
    }[] = []
    const policy = vi.fn(
      () =>
        new Promise<SyncRuleSignal>((resolve, reject) =>
          answers.push({ resolve, reject })
        )
    )
    const rules = new SyncRules(policy, open, () => {})
    const watched = (subscribe = vi.fn(() => () => {})) => ({
      value: syncAll,
      subscribe,
    })
    const stale = rules.rule(tree, "peer")
    rules.forgetTree(tree)
    const current = rules.rule(tree, "peer")
    const late = watched()
    answers[0].resolve(late)
    await stale
    const fresh = watched()
    answers[1].resolve(fresh)
    await current
    expect(late.subscribe).not.toHaveBeenCalled()
    expect(fresh.subscribe).toHaveBeenCalledOnce()

    const rejected = rules.rule(other, "peer")
    rules.forgetTree(other)
    const kept = rules.rule(other, "peer")
    answers[3].resolve(watched())
    await kept
    answers[2].reject(new Error("late failure"))
    await expect(rejected).rejects.toThrow("late failure")
    expect(rules.rule(other, "peer")).toEqual(syncAll)
    expect(policy).toHaveBeenCalledTimes(4)
  })

  it("unsubscribes on close", () => {
    const unsubscribed = vi.fn()
    const signal: SyncRuleSignal = {
      value: syncAll,
      subscribe: () => unsubscribed,
    }
    const rules = new SyncRules(
      () => signal,
      open,
      () => {}
    )
    rules.rule(tree, "peer")
    rules.rule(other, "peer")
    rules.close()
    expect(unsubscribed).toHaveBeenCalledTimes(2)
  })
})

type Peer = {
  repo: Repo
  backend: SubductionBackend
  signer: TestSigner
  rules: ReturnType<typeof pairRules>
}

describe("SubductionBackend sync policy", () => {
  const peers: Peer[] = []
  const wires: RepoTransport[] = []

  function peer(policy?: SyncPolicy): Peer {
    const signer = N.createMemorySigner(
      new Uint8Array(32).fill(peers.length + 1)
    )
    const rules = pairRules()
    const backend = new SubductionBackend({
      storage: new DummySubductionStorageAdapter(),
      signer,
      syncPolicy: policy ?? rules.policy,
      syncTimeoutMilliseconds: 1000,
    })
    const result = { repo: new Repo({ backend }), backend, signer, rules }
    peers.push(result)
    return result
  }

  async function connect(a: Peer, b: Peer) {
    const pair = RepoTransport.pair()
    wires.push(...pair)
    await connectBackends(a, b, pair)
  }

  async function ready<T>(handle: DocHandle<T>, state: T) {
    await vi.waitFor(() => expect(handle.doc()).toEqual(state), wait)
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.allSettled(wires.splice(0).map(wire => wire.disconnect()))
    await Promise.allSettled(peers.map(p => p.repo.shutdown()))
    await Promise.allSettled(peers.splice(0).map(p => p.backend.close()))
  }, 20000)

  it("does not serve a document to a peer denied access", async () => {
    const a = peer(),
      b = peer()
    const hidden = await a.repo.create<State>({ count: 1 })
    const shared = await a.repo.create<State>({ count: 2 })
    a.rules.set(treeOf(hidden.url), b.backend.peerId, deny)
    await a.repo.flush()
    await connect(a, b)
    await expect(b.repo.find(hidden.url)).rejects.toThrow("unavailable")
    expect((await b.repo.find<State>(shared.url)).doc()).toEqual({ count: 2 })
  }, 20000)

  it("does not accept a document from a peer denied access", async () => {
    const a = peer(),
      b = peer()
    const source = await b.repo.create<State>({ count: 1 })
    await b.repo.flush()
    a.rules.set(treeOf(source.url), b.backend.peerId, deny)
    await connect(a, b)
    await expect(a.repo.find(source.url)).rejects.toThrow("unavailable")
    // Native's own rounds and b's pushes may still deliver; a must drop them.
    await source.change(d => {
      d.count = 2
    })
    await b.repo.flush()
    await pause(300)
    expect(await nodeOf(a.backend).getHeads(treeOf(source.url))).toBeFalsy()
  }, 20000)

  it("stops exchanging changes once denied, and catches up when granted", async () => {
    const a = peer(),
      b = peer()
    const source = await a.repo.create<State>({ count: 0 })
    await connect(a, b)
    const receiver = await b.repo.find<State>(source.url)
    await ready(receiver, { count: 0 })
    const id = treeOf(source.url)
    a.rules.set(id, b.backend.peerId, { access: false })
    await receiver.change(d => {
      d.count = 1
    })
    await source.change(d => {
      d.count = 2
    })
    await b.repo.flush()
    await a.repo.flush()
    await pause(300)
    expect(source.doc()).toEqual({ count: 2 })
    expect(receiver.doc()).toEqual({ count: 1 })
    // No further write: the grant alone starts a round.
    a.rules.set(id, b.backend.peerId, { access: true })
    const merged = A.merge(A.clone(source.fullDoc()), receiver.fullDoc())
    await ready(source, merged)
    await ready(receiver, merged)
  }, 20000)

  it("applies an asynchronous policy, and catches up when its signal changes", async () => {
    const signals = new Map<string, ReturnType<typeof syncRule>>()
    const a = peer(async (doc, peerId) => {
      await pause(5)
      const signal = syncRule(deny)
      signals.set(`${doc}/${peerId}`, signal)
      return signal
    })
    const b = peer()
    const source = await b.repo.create<State>({ count: 1 })
    await b.repo.flush()
    await connect(a, b)
    const id = treeOf(source.url)
    const watching = a.backend.open(id)
    await pause(300)
    expect(await nodeOf(a.backend).getHeads(id)).toBeFalsy()
    signals.get(`${id}/${b.backend.peerId}`)!.set(syncAll)
    await vi.waitFor(
      async () =>
        expect(await nodeOf(a.backend).getHeads(id)).toEqual(
          await nodeOf(b.backend).getHeads(id)
        ),
      wait
    )
    await watching.close()
  }, 20000)

  it("exchanges no ephemeral messages with a peer denied access", async () => {
    const a = peer(),
      b = peer()
    const local = await a.repo.create<State>({ count: 0 })
    await connect(a, b)
    const remote = await b.repo.find<State>(local.url)
    const atA = vi.fn(),
      atB = vi.fn()
    local.on("ephemeral-message", atA)
    remote.on("ephemeral-message", atB)
    const id = treeOf(local.url)
    a.rules.set(id, b.backend.peerId, { access: false })
    local.broadcast("denied")
    remote.broadcast("denied")
    await pause(200)
    a.rules.set(id, b.backend.peerId, { access: true })
    local.broadcast("allowed")
    remote.broadcast("allowed")
    await vi.waitFor(() => {
      expect(atA).toHaveBeenCalled()
      expect(atB).toHaveBeenCalled()
    }, wait)
    for (const received of [atA, atB])
      expect(received.mock.calls.map(([event]) => event.message)).toEqual([
        "allowed",
      ])
  }, 20000)

  it("does not start rounds with a peer it does not announce to", async () => {
    const a = peer(),
      b = peer()
    await connect(a, b)
    const engine = nodeOf(a.backend)
    const all = vi.spyOn(engine, "syncWithAllPeers")
    const one = vi.spyOn(engine, "syncWithPeer")
    const first = fixture("6a6a6a", 5)
    const second = A.change(
      A.change(A.clone(first), { time: 0 }, d => void d.count++),
      { time: 0 },
      d => void d.count++
    )
    const id = sedimentreeId("b2".repeat(16) + "00".repeat(16))
    a.rules.set(id, b.backend.peerId, { announce: false })
    await a.backend.create(extractRecords(first), { documentId: id })
    await a.backend.flush()
    await pause(100)
    expect(all).not.toHaveBeenCalled()
    expect(one).not.toHaveBeenCalled()
    a.rules.set(id, b.backend.peerId, { announce: true })
    // A batch with no open session reaches peers only through our round.
    await a.backend.store(id, extractRecords(second))
    await vi.waitFor(() => expect(all).toHaveBeenCalledOnce(), wait)
  }, 20000)

  it("still announces to other peers when the policy fails for one", async () => {
    let failing = ""
    const a = peer(async (_doc, peerId) => {
      if (peerId === failing) throw new Error("lookup failed")
      return syncRule(syncAll)
    })
    const b = peer(),
      c = peer()
    failing = b.backend.peerId
    await connect(a, b)
    await connect(a, c)
    const id = sedimentreeId("b3".repeat(16) + "00".repeat(16))
    await a.backend.create(extractRecords(fixture("5d5d5d", 1)), {
      documentId: id,
    })
    await vi.waitFor(
      async () => expect(await nodeOf(c.backend).getHeads(id)).toHaveLength(1),
      wait
    )
    expect(await nodeOf(b.backend).getHeads(id)).toBeFalsy()
  }, 20000)

  it("serves and pushes to a peer that asks, without announcing to it", async () => {
    const a = peer(),
      b = peer()
    const source = await a.repo.create<State>({ count: 0 })
    a.rules.set(treeOf(source.url), b.backend.peerId, { announce: false })
    await a.repo.flush()
    await connect(a, b)
    const receiver = await b.repo.find<State>(source.url)
    expect(receiver.doc()).toEqual({ count: 0 })
    await source.change(d => {
      d.count = 1
    })
    await ready(receiver, { count: 1 })
  }, 20000)
})
