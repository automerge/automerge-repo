import * as A from "@automerge/automerge"
import {
  Repo,
  decodeHeads,
  parseAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo"
import {
  ChangeId,
  DocumentId,
  Identifier,
  type Keyhive,
  Power,
} from "@keyhive/keyhive/slim"
import {
  commitId,
  idBytes,
  isBoundary,
  sedimentreeId,
} from "@automerge/automerge-repo/sedimentree"
import type { DocKeyhive } from "../src/index.js"
import { log } from "../src/logging.js"
import { uint8ArrayToHex } from "../src/utilities.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  connect,
  createPeer,
  readerWithoutKeys,
  unseenCommit,
  type TestPeer,
} from "./helpers.js"

interface Note {
  text: string
}

const options = { timeout: 10000, interval: 100 }

/**
 * The heads of `url`'s document that later revocations by `keyhive` record,
 * read before the backend frees them.
 */
function retainedHeads(keyhive: Keyhive, url: AutomergeUrl): string[] {
  const doc = new DocumentId(parseAutomergeUrl(url).binaryDocumentId)
  const heads: string[] = []
  const revoke = keyhive.revokeMember.bind(keyhive)
  vi.spyOn(keyhive, "revokeMember").mockImplementation(async (...args) => {
    const revocations = await revoke(...args)
    for (const signed of revocations) {
      for (const head of signed.revocation?.retained(doc) ?? []) {
        heads.push(uint8ArrayToHex(head.toBytes()))
      }
    }
    return revocations
  })
  return heads
}

describe("document membership through DocKeyhive", () => {
  const cleanup: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step()
  })

  async function repoOf(peer: TestPeer) {
    const repo = new Repo({ backend: peer.backend })
    cleanup.push(() => repo.shutdown())
    return repo
  }

  async function link(a: TestPeer, b: TestPeer) {
    const { disconnect } = await connect(a, b)
    cleanup.push(disconnect)
  }

  it("lets an earlier member read writes made after a later member is added", async () => {
    const [alice, bob, carol] = [
      await createPeer(),
      await createPeer(),
      await createPeer(),
    ]
    await link(alice, bob)
    await link(alice, carol)
    const [aliceRepo, bobRepo, carolRepo] = [
      await repoOf(alice),
      await repoOf(bob),
      await repoOf(carol),
    ]
    const handle = await aliceRepo.create<Note>({ text: "for bob" })
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await bob.backend.repoKeyhive().contactCard(),
        Power.read()
      )
    const atBob = await bobRepo.find<Note>(handle.url)
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await carol.backend.repoKeyhive().contactCard(),
        Power.read()
      )
    handle.change(note => {
      note.text = "after carol"
    })

    const atCarol = await carolRepo.find<Note>(handle.url)
    await vi.waitFor(() => {
      expect(atBob.doc()).toEqual({ text: "after carol" })
      expect(atCarol.doc()).toEqual({ text: "after carol" })
    }, options)
  }, 20000)

  it("shares a document with the members of a group", async () => {
    const [alice, bob] = [await createPeer(), await createPeer()]
    await link(alice, bob)
    const [aliceRepo, bobRepo] = [await repoOf(alice), await repoOf(bob)]
    const team = alice.backend.repoKeyhive()
    const group = await team.createGroup()
    await team.addGroupMemberFromContactCard(
      group,
      await bob.backend.repoKeyhive().contactCard(),
      Power.read()
    )
    const handle = await aliceRepo.create<Note>({ text: "for the group" })
    await handle.keyhive().addMember(group.toIdentifier(), Power.read())

    const atBob = await bobRepo.find<Note>(handle.url)
    expect(atBob.doc()).toEqual({ text: "for the group" })
  }, 20000)

  it("resolves a revoked member's edits once access returns", async () => {
    const [alice, bob] = [await createPeer(), await createPeer()]
    await link(alice, bob)
    const [aliceRepo, bobRepo] = [await repoOf(alice), await repoOf(bob)]
    const handle = await aliceRepo.create<Note>({ text: "first" })
    const card = await bob.backend.repoKeyhive().contactCard()
    await handle.keyhive().addMemberFromContactCard(card, Power.edit())
    const atBob = await bobRepo.find<Note>(handle.url)
    await handle
      .keyhive()
      .revokeMember(new Identifier(bob.keyhive.id.toBytes()))
    await vi.waitFor(
      async () => expect(await atBob.keyhive().myAccess()).toBeUndefined(),
      { timeout: 8000 }
    )
    let durable = false
    const writes = Promise.all(
      ["waiting one", "waiting two"].map(text =>
        atBob.change(note => {
          note.text = text
        })
      )
    ).then(() => (durable = true))
    await expect(bobRepo.flush()).rejects.toMatchObject({
      errors: [expect.objectContaining({ retryable: true })],
    })

    expect(durable).toBe(false)
    expect(handle.doc()).toEqual({ text: "first" })
    await handle.keyhive().addMemberFromContactCard(card, Power.edit())
    await writes
    await vi.waitFor(
      () => expect(handle.doc()).toEqual({ text: "waiting two" }),
      options
    )
  }, 40000)

  it("drops a commit whose decrypted change is not the commit it claims", async () => {
    const [alice, bob] = [await createPeer(), await createPeer()]
    await link(alice, bob)
    const [aliceRepo, bobRepo] = [await repoOf(alice), await repoOf(bob)]
    const handle = await aliceRepo.create<Note>({ text: "first" })
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await bob.backend.repoKeyhive().contactCard(),
        Power.edit()
      )
    const atBob = await bobRepo.find<Note>(handle.url)
    const forged = A.getLastLocalChange(
      A.change(A.clone(atBob.doc()), note => {
        note.text = "forged"
      })
    )!
    const encrypt = bob.keyhive.tryEncrypt.bind(bob.keyhive)
    vi.spyOn(bob.keyhive, "tryEncrypt").mockImplementation((doc, ref, preds) =>
      encrypt(doc, ref, preds, forged)
    )
    const dropped = vi.spyOn(log, "warn")
    cleanup.push(async () => dropped.mockRestore())

    atBob.change(note => {
      note.text = "honest"
    })
    await vi.waitFor(
      () =>
        expect(dropped).toHaveBeenCalledWith(
          expect.stringContaining("does not match")
        ),
      options
    )
    expect(handle.doc()).toEqual({ text: "first" })
  }, 20000)

  it("reads a commit whose ref a forged commit claimed first", async () => {
    const [alice, bob] = [await createPeer(), await createPeer()]
    await link(alice, bob)
    const [aliceRepo, bobRepo] = [await repoOf(alice), await repoOf(bob)]
    const handle = await aliceRepo.create<Note>({ text: "first" })
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await bob.backend.repoKeyhive().contactCard(),
        Power.edit()
      )
    const atBob = await bobRepo.find<Note>(handle.url)
    const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
    const genuine = unseenCommit(atBob.doc()!, "genuine")
    const forged = unseenCommit(atBob.doc()!, "forged")
    const encrypt = bob.keyhive.tryEncrypt.bind(bob.keyhive)
    vi.spyOn(bob.keyhive, "tryEncrypt").mockImplementation(
      (doc, ref, preds, content) =>
        uint8ArrayToHex(ref.toBytes()) === forged.id
          ? encrypt(doc, new ChangeId(idBytes(genuine.id)), preds, content)
          : encrypt(doc, ref, preds, content)
    )

    await bob.backend.store(id, [forged])
    await bob.backend.store(id, [genuine])

    await vi.waitFor(
      () => expect(handle.doc()).toEqual({ text: "genuine" }),
      options
    )
  }, 20000)

  it("opens a document whose newest commit builds on a dropped one", async () => {
    const [alice, bob, carol] = [
      await createPeer(),
      await createPeer(),
      await createPeer(),
    ]
    await link(alice, bob)
    const { disconnect } = await connect(alice, carol)
    const [aliceRepo, bobRepo] = [await repoOf(alice), await repoOf(bob)]
    const carolRepo = new Repo({ backend: carol.backend })
    const handle = await aliceRepo.create<Note>({ text: "first" })
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await bob.backend.repoKeyhive().contactCard(),
        Power.edit()
      )
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await carol.backend.repoKeyhive().contactCard(),
        Power.read()
      )
    const atBob = await bobRepo.find<Note>(handle.url)
    await carolRepo.find<Note>(handle.url)
    const forged = A.getLastLocalChange(
      A.change(A.clone(atBob.doc()), note => {
        note.text = "forged"
      })
    )!
    const encrypt = bob.keyhive.tryEncrypt.bind(bob.keyhive)
    const forge = vi
      .spyOn(bob.keyhive, "tryEncrypt")
      .mockImplementation((doc, ref, preds) => encrypt(doc, ref, preds, forged))
    atBob.change(note => {
      note.text = "dropped"
    })
    await bobRepo.flush()
    forge.mockRestore()
    atBob.change(note => {
      note.text = "on top of it"
    })
    await bobRepo.flush()
    const top = commitId(decodeHeads(atBob.heads())[0])
    const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
    await vi.waitFor(async () => {
      const heads = (await carol.inner.subduction.getHeads(id)) ?? []
      expect(heads.map(commitId)).toContain(top)
      expect(carol.backend.pendingCount(id)).toBe(0)
    }, options)
    await carolRepo.flush()
    await carolRepo.shutdown()
    await disconnect()

    // After a restart Carol reads every record from storage at once, so her
    // first marker already includes the commit built on the dropped one.
    const restarted = await createPeer(carol.keys, carol.storage)
    const reopened = await (
      await repoOf(restarted)
    ).find<Note>(handle.url, { signal: AbortSignal.timeout(10000) })
    expect(reopened.doc()).toEqual({ text: "first" })
  }, 40000)

  it("lets a member added after compaction read the document", async () => {
    const [alice, bob] = [await createPeer(), await createPeer()]
    await link(alice, bob)
    const [aliceRepo, bobRepo] = [await repoOf(alice), await repoOf(bob)]
    const handle = await aliceRepo.create<{ n: number }>({ n: 0 })
    // Bob receives each loose commit as it is written, then the fragment
    // that compacts them, so he has a pending commit and a pending fragment
    // with the same head.
    while (!isBoundary(commitId(decodeHeads(handle.heads())[0]))) {
      handle.change(doc => void doc.n++)
    }
    await aliceRepo.flush()
    handle.change(doc => void doc.n++)
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await bob.backend.repoKeyhive().contactCard(),
        Power.read()
      )
    handle.change(doc => void doc.n++)

    const atBob = await bobRepo.find<{ n: number }>(handle.url)
    await vi.waitFor(() => expect(atBob.doc()).toEqual(handle.doc()), options)
    const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
    await vi.waitFor(
      () => expect(bob.backend.pendingCount(id)).toBe(0),
      options
    )
  }, 30000)

  it("sends a change at an old head by a member who joined after compaction", async () => {
    const [alice, carol] = [await createPeer(), await createPeer()]
    const aliceRepo = await repoOf(alice)
    const handle = await aliceRepo.create<Note & { n: number }>({
      text: "",
      n: 0,
    })
    handle.change(doc => void doc.n++)
    const early = handle.heads()
    while (!isBoundary(commitId(decodeHeads(handle.heads())[0]))) {
      handle.change(doc => void doc.n++)
    }
    await aliceRepo.flush()
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await carol.backend.repoKeyhive().contactCard(),
        Power.edit()
      )
    handle.change(doc => void doc.n++)
    await aliceRepo.flush()

    await link(alice, carol)
    const atCarol = await (
      await repoOf(carol)
    ).find<Note & { n: number }>(handle.url)
    await vi.waitFor(
      () => expect(atCarol.doc().n).toBe(handle.doc().n),
      options
    )
    await atCarol.changeAt(early, doc => {
      doc.text = "at an early head"
    })
    await vi.waitFor(
      () => expect(handle.doc().text).toBe("at an early head"),
      options
    )
  }, 30000)

  it("hides edits made after a member is revoked", async () => {
    const [alice, bob] = [await createPeer(), await createPeer()]
    await link(alice, bob)
    const [aliceRepo, bobRepo] = [await repoOf(alice), await repoOf(bob)]
    const handle = await aliceRepo.create<Note>({ text: "before" })
    const doc = handle.keyhive()
    const card = await bob.backend.repoKeyhive().contactCard()
    await doc.addMemberFromContactCard(card, Power.read())
    const atBob = await bobRepo.find<Note>(handle.url)
    expect(atBob.doc()).toEqual({ text: "before" })
    readerWithoutKeys(bob.keyhive)

    await doc.revokeMember(new Identifier(card.id.toBytes()))
    handle.change(d => {
      d.text = "after"
    })
    await aliceRepo.flush()

    const bobDoc = atBob.keyhive()
    await vi.waitFor(
      () => expect(bobDoc.pendingCount).toBeGreaterThan(0),
      options
    )
    // Long enough for several keyhive sync rounds to have run.
    await new Promise(resolve => setTimeout(resolve, 5000))
    expect(atBob.doc()).toEqual({ text: "before" })
  }, 20000)

  it("hides edits made after a member is revoked from a group", async () => {
    const [alice, bob] = [await createPeer(), await createPeer()]
    await link(alice, bob)
    const [aliceRepo, bobRepo] = [await repoOf(alice), await repoOf(bob)]
    const team = alice.backend.repoKeyhive()
    const group = await team.createGroup()
    await team.addGroupMemberFromContactCard(
      group,
      await bob.backend.repoKeyhive().contactCard(),
      Power.read()
    )
    const handle = await aliceRepo.create<Note>({ text: "before" })
    await handle.keyhive().addMember(group.toIdentifier(), Power.read())
    const atBob = await bobRepo.find<Note>(handle.url)
    readerWithoutKeys(bob.keyhive)

    await team.revokeGroupMember(
      group,
      new Identifier(bob.signer.verifyingKey())
    )
    handle.change(note => {
      note.text = "after"
    })
    await aliceRepo.flush()

    await vi.waitFor(
      () => expect(atBob.keyhive().pendingCount).toBeGreaterThan(0),
      options
    )
    // Long enough for several keyhive sync rounds to have run.
    await new Promise(resolve => setTimeout(resolve, 5000))
    expect(atBob.doc()).toEqual({ text: "before" })
  }, 20000)

  it("records the document's latest heads when revoking through a view handle", async () => {
    const [alice, bob] = [await createPeer(), await createPeer()]
    const handle = await (await repoOf(alice)).create<Note>({ text: "first" })
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await bob.backend.repoKeyhive().contactCard(),
        Power.read()
      )
    const view = handle.view(handle.heads())
    handle.change(doc => {
      doc.text = "second"
    })
    const retained = retainedHeads(alice.keyhive, handle.url)

    await view.keyhive().revokeMember(new Identifier(bob.signer.verifyingKey()))
    expect(retained).toEqual(decodeHeads(handle.heads()))
  })

  it("records the document's latest heads when revoking a member of a group", async () => {
    const [alice, bob] = [await createPeer(), await createPeer()]
    const team = alice.backend.repoKeyhive()
    const group = await team.createGroup()
    await team.addGroupMemberFromContactCard(
      group,
      await bob.backend.repoKeyhive().contactCard(),
      Power.read()
    )
    const repo = await repoOf(alice)
    const handle = await repo.create<Note>({ text: "shared" })
    await handle.keyhive().addMember(group.toIdentifier(), Power.read())
    handle.change(doc => {
      doc.text = "changed"
    })
    await repo.flush()
    const retained = retainedHeads(alice.keyhive, handle.url)

    await team.revokeGroupMember(
      group,
      new Identifier(bob.signer.verifyingKey())
    )
    expect(retained).toEqual(decodeHeads(handle.heads()))
  })

  async function expectRelayAccess(document: DocKeyhive, key: Uint8Array) {
    await vi.waitFor(
      async () =>
        expect(
          (await document.accessFor(new Identifier(key)))?.toString()
        ).toBe(Power.relay().toString()),
      options
    )
  }

  it("grants Relay on a document created before keyhive knew the relay", async () => {
    const relay = await createPeer()
    const key = relay.signer.verifyingKey()
    const alice = await createPeer(undefined, undefined, { relays: [key] })
    const handle = await (await repoOf(alice)).create<Note>({ text: "kept" })

    await link(alice, relay)
    await expectRelayAccess(handle.keyhive(), key)
  }, 20000)

  it("grants Relay on existing documents to a relay added later", async () => {
    const [alice, relay] = [await createPeer(), await createPeer()]
    const handle = await (await repoOf(alice)).create<Note>({ text: "kept" })
    await link(alice, relay)

    alice.backend.addRelay(relay.signer.verifyingKey())
    await expectRelayAccess(handle.keyhive(), relay.signer.verifyingKey())
  }, 20000)

  /**
   * A relay that has Relay access to a document of alice's, knows it, and
   * keeps the document open as a server does.
   */
  async function relayWithDocument() {
    const relay = await createPeer()
    const key = relay.signer.verifyingKey()
    const alice = await createPeer(undefined, undefined, { relays: [key] })
    await link(alice, relay)
    const aliceRepo = await repoOf(alice)
    const handle = await aliceRepo.create<Note>({ text: "kept" })
    const doc = new DocumentId(parseAutomergeUrl(handle.url).binaryDocumentId)
    const access = vi.spyOn(relay.keyhive, "accessForDoc")
    await vi.waitFor(
      async () =>
        expect(
          (
            await relay.keyhive.accessForDoc(new Identifier(key), doc)
          )?.toString()
        ).toBe(Power.relay().toString()),
      options
    )
    const relayRepo = await repoOf(relay)
    const unsubscribe = relayRepo.query(handle.url).subscribe(() => {})
    cleanup.push(async () => unsubscribe())
    const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
    return { alice, aliceRepo, relay, relayRepo, handle, doc, key, id, access }
  }

  it("makes no decryption attempts at a replica with Relay access only", async () => {
    const { alice, aliceRepo, relay, handle, doc, id, access } =
      await relayWithDocument()
    const decrypt = vi.spyOn(relay.keyhive, "tryCausalDecrypt")
    handle.change(note => {
      note.text = "changed"
    })
    await aliceRepo.flush()
    await vi.waitFor(
      () => expect(relay.backend.pendingCount(id)).toBeGreaterThanOrEqual(2),
      options
    )

    // A key rotation reaches the relay, which then either checks its access
    // or tries its pending records.
    const before = access.mock.calls.length
    await alice.backend.local.queue.run(() => alice.keyhive.forcePcsUpdate(doc))
    alice.backend.syncKeyhive()
    await vi.waitFor(
      () =>
        expect(
          access.mock.calls.length - before + decrypt.mock.calls.length
        ).toBeGreaterThan(0),
      options
    )
    expect(decrypt).not.toHaveBeenCalled()
  }, 20000)

  it("opens the records a relay holds once it is given Read", async () => {
    const { relayRepo, handle, key } = await relayWithDocument()

    await handle.keyhive().addMember(new Identifier(key), Power.read())

    const read = await relayRepo.find<Note>(handle.url)
    expect(read.doc()).toEqual({ text: "kept" })
  }, 20000)

  it("grants Relay again after a grant fails", async () => {
    const [alice, relay] = [await createPeer(), await createPeer()]
    const handle = await (await repoOf(alice)).create<Note>({ text: "kept" })
    await link(alice, relay)
    const error = new Error("storage failed")
    vi.spyOn(alice.keyhive, "addMemberToEach")
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
    const failure = vi.spyOn(log, "error").mockImplementation(() => {})
    cleanup.push(async () => failure.mockRestore())

    alice.backend.addRelay(relay.signer.verifyingKey())
    await expectRelayAccess(handle.keyhive(), relay.signer.verifyingKey())
    expect(failure).toHaveBeenCalledOnce()
  }, 20000)

  it("grants each document of a failed batch on its own", async () => {
    const [alice, relay] = [await createPeer(), await createPeer()]
    const repo = await repoOf(alice)
    const handles = [
      await repo.create<Note>({ text: "one" }),
      await repo.create<Note>({ text: "two" }),
    ]
    await link(alice, relay)
    vi.spyOn(alice.keyhive, "addMemberToEach").mockRejectedValueOnce(
      new Error("one document cannot be granted")
    )
    const failure = vi.spyOn(log, "error").mockImplementation(() => {})
    cleanup.push(async () => failure.mockRestore())

    alice.backend.addRelay(relay.signer.verifyingKey())
    for (const handle of handles) {
      await expectRelayAccess(handle.keyhive(), relay.signer.verifyingKey())
    }
    expect(failure).not.toHaveBeenCalled()
  }, 20000)
})
