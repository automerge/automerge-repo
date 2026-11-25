import { Repo, decodeHeads, parseAutomergeUrl } from "@automerge/automerge-repo"
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree"
import { Power } from "@keyhive/keyhive/slim"
import { afterEach, expect, it, vi } from "vitest"
import type { KeyhiveBackendOptions } from "../src/index.js"
import { syncRule } from "@automerge/automerge-repo-subduction"
import { PairedTransport } from "../../automerge-repo-subduction/test/transport.js"
import { connect, createPeer } from "./helpers.js"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function linkedPeers(options?: Partial<KeyhiveBackendOptions>) {
  const [alice, bob] = [
    await createPeer(undefined, options),
    await createPeer(undefined, options),
  ]
  const { disconnect } = await connect(alice, bob)
  const repo = new Repo({ backend: alice.backend })
  const bobRepo = new Repo({ backend: bob.backend })
  cleanup.push(
    disconnect,
    () => bobRepo.shutdown(),
    () => repo.shutdown()
  )
  return { alice, bob, repo, bobRepo }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

it("keeps a document received from a peer after a crash", async () => {
  const { bob, repo, bobRepo } = await linkedPeers()
  const handle = await repo.create({ text: "kept" })
  const card = await bob.backend.keyhive().getExistingContactCard()
  await handle.keyhive().addMemberFromContactCard(card, Power.read())
  await bobRepo.find(handle.url, { signal: AbortSignal.timeout(10000) })
  await bob.backend.flush()

  const reopened = await createPeer(bob.storage)
  const offlineRepo = new Repo({ backend: reopened.backend })
  cleanup.push(() => offlineRepo.shutdown())
  const found = await offlineRepo.find<{ text: string }>(handle.url, {
    signal: AbortSignal.timeout(5000),
  })
  expect(found.doc()).toEqual({ text: "kept" })
}, 25000)

it("delivers ephemeral messages between handles", async () => {
  const { bob, repo, bobRepo } = await linkedPeers()
  const handle = await repo.create({ text: "live" })
  await handle
    .keyhive()
    .addMemberFromContactCard(
      await bob.backend.keyhive().getExistingContactCard(),
      Power.read()
    )
  const atBob = await bobRepo.find(handle.url, {
    signal: AbortSignal.timeout(10000),
  })
  const received = vi.fn()
  atBob.on("ephemeral-message", ({ message }) => received(message))

  // Repeated, because bob's subscription to the document can still be on its way.
  await vi.waitFor(() => {
    handle.broadcast({ cursor: 3 })
    expect(received).toHaveBeenCalledWith({ cursor: 3 })
  }, 5000)
}, 25000)

it("runs one keyhive round at a time with each peer", async () => {
  const { alice } = await linkedPeers({ syncIntervalMs: 50 })
  const subduction = alice.inner.subduction
  const round = subduction.syncKeyhiveWithPeer.bind(subduction)
  let running = 0
  let most = 0
  const rounds = vi
    .spyOn(subduction, "syncKeyhiveWithPeer")
    .mockImplementation(async peer => {
      most = Math.max(most, ++running)
      try {
        await sleep(400)
        return await round(peer)
      } finally {
        running--
      }
    })

  await sleep(1500)
  expect(rounds.mock.calls.length).toBeGreaterThan(1)
  expect(most).toBe(1)
}, 15000)

it("keeps syncing keyhive with other peers while one peer's round does not finish", async () => {
  const { alice } = await linkedPeers({ syncIntervalMs: 50 })
  const carol = await createPeer(undefined, { syncIntervalMs: 50 })
  const { disconnect } = await connect(alice, carol)
  cleanup.push(disconnect, () => carol.backend.close())
  const subduction = alice.inner.subduction
  const round = subduction.syncKeyhiveWithPeer.bind(subduction)
  let stuck: string | undefined
  let others = 0
  vi.spyOn(subduction, "syncKeyhiveWithPeer").mockImplementation(peer => {
    stuck ??= peer
    if (peer === stuck) return new Promise(() => {})
    others++
    return round(peer)
  })

  await sleep(1000)
  expect(others).toBeGreaterThan(1)
}, 15000)

it("runs no sedimentree rounds while keyhive state is unchanged", async () => {
  const { alice, repo } = await linkedPeers({ syncIntervalMs: 200 })
  await repo.create({ text: "quiet" })
  // Long enough for the rounds that creating the document starts to finish.
  await sleep(1500)
  const rounds = vi.spyOn(alice.inner.subduction, "syncWithAllPeers")

  await sleep(700)
  expect(rounds).not.toHaveBeenCalled()
}, 15000)

/**
 * Pass `events` on, keeping its `records` events so that `replay` can deliver
 * them again. `replay` returns how many it delivered.
 */
function replayable<E extends { type: string }>(events: AsyncIterable<E>) {
  const kept: E[] = []
  const queue: (E | undefined)[] = []
  let wake = () => {}
  const push = (event: E | undefined) => {
    queue.push(event)
    wake()
  }
  void (async () => {
    for await (const event of events) {
      if (event.type === "records") kept.push(event)
      push(event)
    }
    push(undefined)
  })()
  async function* passed(): AsyncGenerator<E> {
    for (;;) {
      while (queue.length) {
        const event = queue.shift()
        if (!event) return
        yield event
      }
      await new Promise<void>(resolve => (wake = resolve))
    }
  }
  const replay = () => {
    kept.forEach(push)
    return kept.length
  }
  return { events: passed(), replay }
}

it("does not decrypt a record again when the inner session delivers it again", async () => {
  const { bob, repo, bobRepo } = await linkedPeers()
  const replays: (() => number)[] = []
  const open = bob.inner.open.bind(bob.inner)
  vi.spyOn(bob.inner, "open").mockImplementation(id => {
    const session = open(id)
    const { events, replay } = replayable(session.events)
    replays.push(replay)
    return { ...session, events }
  })
  const handle = await repo.create({ n: 0 })
  for (let n = 1; n <= 5; n++) {
    handle.change(doc => void (doc.n = n))
    await repo.flush()
  }
  const card = await bob.backend.keyhive().getExistingContactCard()
  await handle.keyhive().addMemberFromContactCard(card, Power.read())
  const found = await bobRepo.find<{ n: number }>(handle.url, {
    signal: AbortSignal.timeout(10000),
  })
  await vi.waitFor(() => expect(found.doc()).toEqual({ n: 5 }))
  const decrypt = vi.spyOn(bob.keyhive, "tryCausalDecrypt")

  const replayed = replays.reduce((n, replay) => n + replay(), 0)
  expect(replayed).toBeGreaterThan(0)
  await sleep(500)
  expect(decrypt).not.toHaveBeenCalled()
}, 15000)

/** Wait until the rounds `spy` saw have finished and no new one started. */
async function settle(spy: {
  mock: { calls: unknown[]; results: { value: unknown }[] }
}) {
  let started
  do {
    started = spy.mock.calls.length
    await Promise.allSettled(spy.mock.results.map(({ value }) => value))
  } while (spy.mock.calls.length !== started)
}

it("does not re-sync a readable document after a keyhive change", async () => {
  const { alice, bob, repo, bobRepo } = await linkedPeers({
    syncIntervalMs: null,
    backupSyncIntervalMs: null,
  })
  const card = await bob.backend.keyhive().getExistingContactCard()
  const first = await repo.create({ text: "first" })
  await first.keyhive().addMemberFromContactCard(card, Power.read())
  const foundFirst = bobRepo.find(first.url, {
    signal: AbortSignal.timeout(10000),
  })
  alice.backend.syncKeyhive()
  await foundFirst
  const firstId = sedimentreeId(parseAutomergeUrl(first.url).binaryDocumentId)
  const rounds = vi.spyOn(bob.inner.subduction, "syncWithAllPeers")
  const roundIds = () => rounds.mock.calls.map(([id]) => id)

  // As a member, Bob now shares his initial prekeys with Alice. Alice's
  // confirmation that she received them re-syncs his open documents.
  bob.backend.syncKeyhive()
  await vi.waitFor(() => expect(roundIds()).toContain(firstId), {
    timeout: 10000,
  })
  await settle(rounds)
  rounds.mockClear()

  const second = await repo.create({ text: "second" })
  await second.keyhive().addMemberFromContactCard(card, Power.read())
  const foundSecond = bobRepo.find(second.url, {
    signal: AbortSignal.timeout(10000),
  })
  alice.backend.syncKeyhive()
  await foundSecond
  await settle(rounds)
  expect(roundIds()).not.toContain(firstId)
}, 25000)

it("resyncs after a keyhive change only with peers the sync policy announces to", async () => {
  const quiet = () => syncRule({ access: true, announce: false })
  const alice = await createPeer(undefined, { syncPolicy: quiet })
  const bob = await createPeer()
  const { disconnect } = await connect(alice, bob)
  const [repo, bobRepo] = [
    new Repo({ backend: alice.backend }),
    new Repo({ backend: bob.backend }),
  ]
  cleanup.push(
    disconnect,
    () => bobRepo.shutdown(),
    () => repo.shutdown()
  )
  const { subduction } = alice.inner
  const rounds = [
    vi.spyOn(subduction, "syncWithAllPeers"),
    vi.spyOn(subduction, "syncWithPeer"),
  ]
  const resyncs = vi.spyOn(alice.inner, "syncDocument")

  const handle = await repo.create({ text: "not announced" })
  await handle
    .keyhive()
    .addMemberFromContactCard(
      await bob.backend.keyhive().getExistingContactCard(),
      Power.read()
    )
  await bobRepo.find(handle.url, { signal: AbortSignal.timeout(10000) })
  await vi.waitFor(() => expect(resyncs).toHaveBeenCalled(), {
    timeout: 10000,
  })
  await settle(resyncs)
  for (const round of rounds) expect(round).not.toHaveBeenCalled()
}, 25000)

it("delivers a membership change through the backup sync alone", async () => {
  const { bob, repo, bobRepo } = await linkedPeers({
    syncIntervalMs: null,
    backupSyncIntervalMs: 1100,
  })
  const handle = await repo.create({ text: "shared" })
  const card = await bob.backend.keyhive().getExistingContactCard()
  await handle.keyhive().addMemberFromContactCard(card, Power.read())

  const found = await bobRepo.find<{ text: string }>(handle.url, {
    signal: AbortSignal.timeout(10000),
  })
  expect(found.doc()).toEqual({ text: "shared" })
}, 15000)

it("sends no plaintext over the wire", async () => {
  const frames: Uint8Array[] = []
  const send = PairedTransport.prototype.sendBytes
  const spy = vi
    .spyOn(PairedTransport.prototype, "sendBytes")
    .mockImplementation(function (this: PairedTransport, bytes) {
      frames.push(new Uint8Array(bytes))
      return send.call(this, bytes)
    })
  cleanup.push(async () => spy.mockRestore())
  const { bob, repo, bobRepo } = await linkedPeers()
  const handle = await repo.create({ text: "written by alice" })
  await handle
    .keyhive()
    .addMemberFromContactCard(
      await bob.backend.keyhive().getExistingContactCard(),
      Power.edit()
    )
  const atBob = await bobRepo.find<{ text: string }>(handle.url, {
    signal: AbortSignal.timeout(10000),
  })
  atBob.change(doc => {
    doc.text = "written by bob"
  })
  await vi.waitFor(
    () => expect(handle.doc()).toEqual({ text: "written by bob" }),
    { timeout: 15000 }
  )

  expect(frames).not.toEqual([])
  const sent = (text: string) =>
    frames.some(frame => Buffer.from(frame).includes(text))
  expect(sent("written by alice")).toBe(false)
  expect(sent("written by bob")).toBe(false)
}, 40000)

it("converges on concurrent writes by two members", async () => {
  const { bob, repo, bobRepo } = await linkedPeers()
  const handle = await repo.create<Record<string, number>>({})
  await handle
    .keyhive()
    .addMemberFromContactCard(
      await bob.backend.keyhive().getExistingContactCard(),
      Power.edit()
    )
  const atBob = await bobRepo.find<Record<string, number>>(handle.url, {
    signal: AbortSignal.timeout(10000),
  })
  handle.change(doc => {
    doc.alice = 1
  })
  atBob.change(doc => {
    doc.bob = 1
  })
  await vi.waitFor(() => {
    expect(handle.doc()).toEqual({ alice: 1, bob: 1 })
    expect(atBob.doc()).toEqual({ alice: 1, bob: 1 })
  }, 15000)
  expect(decodeHeads(handle.heads())).toHaveLength(2)

  handle.change(doc => {
    doc.merged = 1
  })
  await vi.waitFor(
    () => expect(atBob.doc()).toEqual({ alice: 1, bob: 1, merged: 1 }),
    { timeout: 15000 }
  )
}, 40000)
