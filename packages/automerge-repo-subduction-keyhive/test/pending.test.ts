import { Repo, parseAutomergeUrl } from "@automerge/automerge-repo"
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree"
import { DocumentId, Power } from "@keyhive/keyhive/slim"
import { afterEach, describe, expect, it, vi } from "vitest"
import { uint8ArrayToHex } from "../src/utilities.js"
import { connect, createPeer, readerWithoutKeys } from "./helpers.js"

interface Note {
  text: string
}

/** Keyhive sync runs on its timer unless `manualSync` is set. */
async function sharedPeers(manualSync = false) {
  const options = manualSync ? { syncIntervalMs: null } : undefined
  const [alice, bob] = [
    await createPeer(undefined, undefined, options),
    await createPeer(undefined, undefined, options),
  ]
  const { disconnect } = await connect(alice, bob)
  const aliceRepo = new Repo({ backend: alice.backend })
  const bobRepo = new Repo({ backend: bob.backend })
  const handle = await aliceRepo.create<Note>({ text: "first" })
  const docId = new DocumentId(parseAutomergeUrl(handle.url).binaryDocumentId)
  const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
  const bobPending = () => bob.backend.pendingCount(id)
  const sync = () => {
    alice.backend.syncKeyhive()
    bob.backend.syncKeyhive()
  }
  const addBob = async () =>
    handle
      .keyhive()
      .addMemberFromContactCard(
        await bob.backend.repoKeyhive().contactCard(),
        Power.read()
      )
  const stop = async () => {
    await aliceRepo.shutdown()
    await bobRepo.shutdown()
    await disconnect()
  }
  return {
    alice,
    bob,
    aliceRepo,
    bobRepo,
    handle,
    docId,
    bobPending,
    sync,
    addBob,
    disconnect,
    stop,
  }
}

describe("content that arrives before its key", () => {
  const cleanup: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step()
  })

  it("resolves find once membership arrives after the ciphertext", async () => {
    const peers = await sharedPeers()
    cleanup.push(peers.stop)
    const decrypt = vi.spyOn(peers.bob.keyhive, "tryCausalDecrypt")
    const opened = peers.bobRepo.find<Note>(peers.handle.url)
    await vi.waitFor(() => expect(peers.bobPending()).toBeGreaterThan(0))
    expect(decrypt).not.toHaveBeenCalled()

    await peers.addBob()

    const read = await opened
    expect(read.doc()).toEqual({ text: "first" })
  }, 15000)

  it("does not retry pending records on each arrival", async () => {
    const peers = await sharedPeers(true)
    cleanup.push(peers.stop)
    readerWithoutKeys(peers.bob.keyhive)
    const decrypt = vi.spyOn(peers.bob.keyhive, "tryCausalDecrypt")
    void peers.bobRepo.find<Note>(peers.handle.url).catch(() => {})
    const edits = 20
    for (let i = 0; i < edits; i++) {
      peers.handle.change(doc => {
        doc.text = `edit ${i}`
      })
      await peers.aliceRepo.flush()
    }
    await vi.waitFor(() => expect(peers.bobPending()).toBeGreaterThan(edits))
    expect(decrypt.mock.calls.length).toBeLessThan(2 * edits)
  }, 15000)

  it("tries a record that arrives during a retry before the retry finishes", async () => {
    const peers = await sharedPeers(true)
    cleanup.push(peers.stop)
    const keyhive = peers.bob.keyhive
    readerWithoutKeys(keyhive)
    const decrypt = keyhive.tryCausalDecrypt.bind(keyhive)
    // The content ref of each attempt, in order. Retried attempts are slowed
    // so that the whole retry takes much longer than a new record takes to
    // arrive.
    const attempts: string[] = []
    let slow = false
    vi.spyOn(keyhive, "tryCausalDecrypt").mockImplementation(
      async (doc, encrypted, load) => {
        attempts.push(uint8ArrayToHex(encrypted.contentRef()))
        if (slow) await new Promise(resolve => setTimeout(resolve, 100))
        return decrypt(doc, encrypted, load)
      }
    )
    void peers.bobRepo.find<Note>(peers.handle.url).catch(() => {})
    const edits = 100
    for (let i = 0; i < edits; i++) {
      peers.handle.change(doc => {
        doc.text = `edit ${i}`
      })
      await peers.aliceRepo.flush()
    }
    await vi.waitFor(() => expect(peers.bobPending()).toBeGreaterThan(edits), {
      timeout: 10000,
    })
    const waiting = peers.bobPending()
    const before = attempts.length
    slow = true
    // A keyhive change for bob that gives him no key for the document.
    const team = peers.alice.backend.repoKeyhive()
    await team.addGroupMemberFromContactCard(
      await team.createGroup(),
      await peers.bob.backend.repoKeyhive().contactCard(),
      Power.read()
    )
    peers.sync()
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThan(before), {
      timeout: 10000,
    })

    const aliceKeyhive = peers.alice.keyhive
    const encrypt = aliceKeyhive.tryEncrypt.bind(aliceKeyhive)
    const written: string[] = []
    vi.spyOn(aliceKeyhive, "tryEncrypt").mockImplementation((...args) => {
      written.push(uint8ArrayToHex(args[1].toBytes()))
      return encrypt(...args)
    })
    peers.handle.change(doc => {
      doc.text = "during the retry"
    })
    await peers.aliceRepo.flush()
    expect(written.length).toBeGreaterThan(0)
    const tried = () => attempts.findIndex(ref => written.includes(ref))
    await vi.waitFor(() => expect(tried()).toBeGreaterThan(-1), {
      timeout: 20000,
    })
    // Retries come in batches, so the new record is tried after a batch or
    // two rather than after every pending record.
    expect(tried() - before).toBeLessThan(waiting / 2)
  }, 40000)

  it("never lets a non-member over a direct link read the document", async () => {
    const peers = await sharedPeers()
    cleanup.push(peers.stop)
    void peers.bobRepo.find<Note>(peers.handle.url).catch(() => {})
    peers.handle.change(doc => {
      doc.text = "not for bob"
    })
    await peers.aliceRepo.flush()

    await vi.waitFor(() => expect(peers.bobPending()).toBeGreaterThan(0))
    // Long enough for several keyhive sync rounds to have run.
    await new Promise(resolve => setTimeout(resolve, 5000))
    expect(await peers.bob.keyhive.hasDocument(peers.docId)).toBe(false)
  }, 15000)

  it("keeps ciphertext it cannot decrypt across a restart", async () => {
    const peers = await sharedPeers(true)
    cleanup.push(peers.stop)
    void peers.bobRepo.find<Note>(peers.handle.url).catch(() => {})
    await vi.waitFor(() => expect(peers.bobPending()).toBeGreaterThan(0))
    await peers.bobRepo.shutdown()
    await peers.disconnect()

    const restarted = await createPeer(peers.bob.keys, peers.bob.storage)
    const repo = new Repo({ backend: restarted.backend })
    cleanup.push(() => repo.shutdown())
    void repo.find<Note>(peers.handle.url).catch(() => {})
    const id = sedimentreeId(
      parseAutomergeUrl(peers.handle.url).binaryDocumentId
    )
    await vi.waitFor(() =>
      expect(restarted.backend.pendingCount(id)).toBeGreaterThan(0)
    )
  }, 15000)

  it("hides an edit until the key for it arrives", async () => {
    const peers = await sharedPeers(true)
    cleanup.push(peers.stop)
    await peers.addBob()
    peers.handle.change(doc => {
      doc.text = "shared with Bob"
    })
    await peers.aliceRepo.flush()
    await vi.waitFor(
      async () => {
        peers.sync()
        expect(await peers.bob.keyhive.hasDocument(peers.docId)).toBe(true)
      },
      { timeout: 8000, interval: 250 }
    )
    const read = await peers.bobRepo.find<Note>(peers.handle.url)
    await vi.waitFor(
      () => expect(read.doc()).toEqual({ text: "shared with Bob" }),
      { timeout: 8000 }
    )

    await peers.alice.backend.local.queue.run(() =>
      peers.alice.keyhive.forcePcsUpdate(peers.docId)
    )
    peers.handle.change(doc => {
      doc.text = "needs a newer key"
    })
    await peers.aliceRepo.flush()
    await vi.waitFor(() => expect(peers.bobPending()).toBeGreaterThan(0))
    expect(read.doc()).toEqual({ text: "shared with Bob" })

    const poll = setInterval(peers.sync, 250)
    try {
      await vi.waitFor(
        () => expect(read.doc()).toEqual({ text: "needs a newer key" }),
        { timeout: 8000 }
      )
    } finally {
      clearInterval(poll)
    }
  }, 25000)
})
