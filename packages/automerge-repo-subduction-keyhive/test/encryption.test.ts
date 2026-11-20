import * as A from "@automerge/automerge"
import { Repo, decodeHeads, parseAutomergeUrl } from "@automerge/automerge-repo"
import {
  commitId,
  isBoundary,
  sedimentreeId,
} from "@automerge/automerge-repo/sedimentree"
import { extractFragments } from "@automerge/automerge-repo/sedimentree/automerge"
import { ChangeId, Keyhive, Power } from "@keyhive/keyhive/slim"
import { describe, expect, it, vi } from "vitest"
import { recordRef } from "../src/DocumentRefs.js"
import { uint8ArrayToHex } from "../src/utilities.js"
import {
  createPeer,
  generateKeys,
  unseenCommit,
  type TestPeer,
} from "./helpers.js"

interface Note {
  text: string
}

const secret = "plaintext that must stay out of storage"

function contains(haystack: Uint8Array, text: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(text))
}

describe("KeyhiveBackend persistence", () => {
  it("stores only ciphertext and reads it back after a crash", async () => {
    const keys = await generateKeys()
    const writer = await createPeer(keys)
    const writerRepo = new Repo({ backend: writer.backend })
    const handle = await writerRepo.create<Note>({ text: secret })
    handle.change(doc => {
      doc.text = `${secret}, edited`
    })
    await writerRepo.flush()

    const stored = await writer.storage.loadPrefix("")
    for (const [, bytes] of stored) expect(contains(bytes, secret)).toBe(false)

    const restarted = await createPeer(keys, writer.storage)
    const reader = new Repo({ backend: restarted.backend })
    const reopened = await reader.find<Note>(handle.url)
    expect(reopened.doc()).toEqual({ text: `${secret}, edited` })
    await reader.shutdown()
    await writerRepo.shutdown()
  })

  it("reads its own edit after a crash that follows adding a member", async () => {
    const [writer, member] = [await createPeer(), await createPeer()]
    const writerRepo = new Repo({ backend: writer.backend })
    const handle = await writerRepo.create<Note>({ text: "before" })
    const card = await member.backend.repoKeyhive().contactCard()
    await handle.keyhive().addMemberFromContactCard(card, Power.read())
    handle.change(doc => {
      doc.text = "after"
    })
    await writerRepo.flush()

    const restarted = await createPeer(writer.keys, writer.storage)
    const reader = new Repo({ backend: restarted.backend })
    const reopened = await reader.find<Note>(handle.url)
    expect(reopened.doc()).toEqual({ text: "after" })
    await reader.shutdown()
    await writerRepo.shutdown()
  })

  it("flushes the inner backend while a store is waiting to be encrypted", async () => {
    const writer = await createPeer()
    const repo = new Repo({ backend: writer.backend })
    const handle = await repo.create<Note>({ text: "first" })
    const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
    vi.spyOn(writer.keyhive, "tryEncrypt").mockRejectedValue(
      new Error("no access yet")
    )
    void writer.backend.store(id, [unseenCommit(handle.doc())]).catch(() => {})
    const flushed = vi.spyOn(writer.inner, "flush")

    await expect(writer.backend.flush()).rejects.toMatchObject({
      retryable: true,
    })
    expect(flushed).toHaveBeenCalled()
    await repo.shutdown()
  })

  it("rejects a store waiting to be encrypted when the document is deleted locally", async () => {
    const writer = await createPeer()
    const repo = new Repo({ backend: writer.backend })
    const handle = await repo.create<Note>({ text: "first" })
    const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
    vi.spyOn(writer.keyhive, "tryEncrypt").mockRejectedValue(
      new Error("no access yet")
    )
    let settled = false
    const stored = writer.backend
      .store(id, [unseenCommit(handle.doc())])
      .finally(() => (settled = true))

    await expect(writer.backend.flush([id])).rejects.toMatchObject({
      retryable: true,
    })
    expect(settled).toBe(false)
    await writer.backend.deleteLocal(id)
    await expect(stored).rejects.toMatchObject({ code: "deleted" })
    await repo.shutdown()
  })

  it("rejects a store whose inner store fails", async () => {
    const writer = await createPeer()
    const repo = new Repo({ backend: writer.backend })
    const handle = await repo.create<Note>({ text: "first" })
    const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
    vi.spyOn(writer.inner, "store").mockRejectedValueOnce(
      new Error("disk full")
    )

    await expect(
      writer.backend.store(id, [unseenCommit(handle.doc())])
    ).rejects.toThrow("disk full")
    await repo.shutdown()
  })

  it("rejects a store that fails for a reason other than a missing key", async () => {
    const writer = await createPeer()
    const repo = new Repo({ backend: writer.backend })
    const handle = await repo.create<Note>({ text: "first" })
    const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
    vi.spyOn(writer.keyhive, "hasKeyFor").mockRejectedValue(
      new Error("read failed")
    )

    await expect(
      writer.backend.store(id, [unseenCommit(handle.doc())])
    ).rejects.toThrow("read failed")
    await repo.shutdown()
  })

  it("rejects an invalid record", async () => {
    const writer = await createPeer()
    const repo = new Repo({ backend: writer.backend })
    const handle = await repo.create<Note>({ text: "first" })
    const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
    const record = { ...unseenCommit(handle.doc()), blob: new Uint8Array() }

    await expect(writer.backend.store(id, [record])).rejects.toMatchObject({
      code: "invalid-record",
    })
    await repo.shutdown()
  })

  it("saves keyhive events after a failed write of them", async () => {
    const { backend } = await createPeer()
    const { local } = backend
    const save = vi
      .spyOn(local.storage, "saveEvents")
      .mockRejectedValueOnce(new Error("disk full"))
    await expect(backend.repoKeyhive().createGroup()).rejects.toThrow(
      "disk full"
    )
    const failed = save.mock.calls[0][0]
    expect(failed.length).toBeGreaterThan(0)

    await local.queue.run(() => local.persist())
    const later = save.mock.calls.slice(1).flatMap(([events]) => events)
    expect(later).toEqual(expect.arrayContaining([...failed]))
  })

  it("closes the inner backend when saving keyhive state fails", async () => {
    const peer = await createPeer()
    vi.spyOn(peer.backend.local.storage, "saveArchive").mockRejectedValue(
      new Error("disk full")
    )
    const close = vi.spyOn(peer.inner, "close")

    await expect(peer.backend.close()).rejects.toThrow("disk full")
    expect(close).toHaveBeenCalled()
  })
})

describe("KeyhiveBackend content refs", () => {
  it("encrypts a write after compaction with the fragment as its predecessor", async () => {
    const writer = await createPeer()
    const hex = (ref: ChangeId) => uint8ArrayToHex(ref.toBytes())
    const calls: { ref: string; preds: string[] }[] = []
    const encrypt = writer.keyhive.tryEncrypt.bind(writer.keyhive)
    vi.spyOn(writer.keyhive, "tryEncrypt").mockImplementation(
      (doc, ref, preds, content) => {
        calls.push({ ref: hex(ref), preds: preds.map(hex) })
        return encrypt(doc, ref, preds, content)
      }
    )
    const repo = new Repo({ backend: writer.backend })
    const handle = await repo.create<{ n: number }>({ n: 0 })
    const head = () => decodeHeads(handle.heads())[0]
    while (!isBoundary(commitId(head()))) handle.change(doc => void doc.n++)
    await repo.flush()
    handle.change(doc => void doc.n++)
    await repo.flush()

    const commits = new Set(
      A.getAllChanges(handle.doc()).map(c => A.decodeChange(c).hash)
    )
    const fragments = calls.filter(c => !commits.has(c.ref))
    expect(fragments).toHaveLength(1)
    const child = calls.find(c => c.ref === head())
    expect(child?.preds).toEqual([fragments[0].ref])
    await repo.shutdown()
  })

  /**
   * A new document of `writer`, and a fragment of changes to it that its Repo
   * has not stored.
   */
  async function unstoredFragment(writer: TestPeer) {
    const repo = new Repo({ backend: writer.backend })
    const handle = await repo.create<Note>({ text: "" })
    await repo.flush()
    let doc = A.clone(handle.doc()!)
    const head = () => commitId(A.getHeads(doc)[0])
    while (!isBoundary(head())) doc = A.change(doc, d => void (d.text += "x"))
    const [fragment] = extractFragments(doc, [head()]).records
    const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
    return { repo, id, doc, fragment }
  }

  /** The hex refs `writer` encrypts, in order. It refuses to encrypt a ref
   * while `refuse` returns true for it, and a refused one is not listed. */
  function encryptions(writer: TestPeer, refuse: (ref: string) => boolean) {
    const refs: string[] = []
    const encrypt = writer.keyhive.tryEncrypt.bind(writer.keyhive)
    vi.spyOn(writer.keyhive, "tryEncrypt").mockImplementation((...args) => {
      const ref = uint8ArrayToHex(args[1].toBytes())
      if (refuse(ref)) return Promise.reject(new Error("no access yet"))
      refs.push(ref)
      return encrypt(...args)
    })
    return refs
  }

  it("encrypts a fragment once when two waiting stores hold it", async () => {
    const writer = await createPeer()
    const { repo, id, fragment } = await unstoredFragment(writer)
    let refusing = true
    const refs = encryptions(writer, () => refusing)
    const waiting = [1, 2].map(() => writer.backend.store(id, [fragment]))
    await writer.backend.local.queue.run(async () => {})

    refusing = false
    await Promise.all([...waiting, writer.backend.store(id, [fragment])])
    const ref = recordRef(fragment)
    expect(refs.filter(r => r === ref)).toHaveLength(1)
    await repo.shutdown()
  })

  it("encrypts a fragment once when a waiting store holds it encrypted", async () => {
    const writer = await createPeer()
    const { repo, id, doc, fragment } = await unstoredFragment(writer)
    const ref = recordRef(fragment)
    let refusing = true
    const refs = encryptions(writer, r => refusing && r !== ref)
    const first = writer.backend.store(id, [fragment, unseenCommit(doc)])
    const second = writer.backend.store(id, [fragment])
    await writer.backend.local.queue.run(async () => {})

    refusing = false
    await Promise.all([first, second, writer.backend.store(id, [fragment])])
    expect(refs.filter(r => r === ref)).toHaveLength(1)
    await repo.shutdown()
  })
})
