/**
 * How `SubductionSource` stores a fragment Automerge forms while the user
 * types.
 *
 * Commits saved before the fragment formed are stored loose. Once Automerge
 * absorbs them into the fragment, compaction deletes their loose records,
 * which is only safe once the fragment itself is stored.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { next as A } from "@automerge/automerge"
import { Repo } from "../../src/Repo.js"
import type { DocHandle } from "../../src/DocHandle.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { binaryToDocumentId } from "../../src/AutomergeUrl.js"
import type { BinaryDocumentId, DocumentId, PeerId } from "../../src/types.js"
import type { BlobInterceptor } from "../../src/subduction/source.js"
import { toSedimentreeId } from "../../src/subduction/helpers.js"
import { initSubduction } from "../../src/initSubduction.js"
import { awaitSubductionConnected } from "../helpers/awaitSubductionConnected.js"
import { waitFor } from "../helpers/waitFor.js"
import {
  MeteredEndpoint,
  startMeteredServer,
  type MeteredServer,
} from "../helpers/syncWire.js"

beforeAll(async () => {
  await initSubduction()
})

type TextDoc = { text: string }

/** One character per change, fixed actor and time: the same hashes, and so the same fragments, on every run. */
function typed(n: number): A.Doc<TextDoc> {
  let doc = A.change(
    A.init<TextDoc>({ actor: "f2a9f2a9f2a9f2a9f2a9f2a9f2a9f2a9" }),
    { time: 0 },
    d => {
      d.text = ""
    }
  )
  for (let i = 1; i < n; i++) {
    doc = A.change(doc, { time: 0 }, d => {
      A.splice(
        d,
        ["text"],
        d.text.length,
        0,
        String.fromCharCode(97 + (i % 26))
      )
    })
  }
  return doc
}

const STEP = 10
/** The first multiple of STEP at which `typed` has formed a fragment. */
const N = (() => {
  const all = typed(2000)
  const changes = A.getAllChanges(all)
  let doc = A.init<TextDoc>()
  for (let n = STEP; n <= changes.length; n += STEP) {
    doc = A.applyChanges(doc, changes.slice(n - STEP, n))[0]
    if (A.getFragmentMetadata(doc, { start: 1 }).length > 0) return n
  }
  throw new Error("typed(2000) never forms a fragment")
})()
const changes = A.getAllChanges(typed(N + STEP))
const fragmentHead = A.getFragmentMetadata(typed(N), { start: 1 })[0].head

let docSeq = 0
function nextDocId(): DocumentId {
  docSeq++
  return binaryToDocumentId(
    Uint8Array.from(
      { length: 16 },
      (_, i) => (i * 7 + docSeq) & 0xff
    ) as BinaryDocumentId
  )
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

function repo(
  name: string,
  storage: DummyStorageAdapter,
  options: { server?: MeteredServer; blobInterceptor?: BlobInterceptor } = {}
) {
  const r = new Repo({
    peerId: name as PeerId,
    storage,
    subductionWebsocketEndpoints: options.server
      ? [new MeteredEndpoint(options.server.url, name)]
      : [],
    subductionBlobInterceptor: options.blobInterceptor,
  })
  cleanups.push(() => r.shutdown())
  return r
}

/** How many loose commits the server holds for `documentId`. */
async function serverLoose(server: MeteredServer, documentId: DocumentId) {
  const commits = await server.subduction.getCommits(
    toSedimentreeId(documentId)
  )
  return commits?.length ?? 0
}

/** Type `changes[from..to)` onto `handle` a step at a time, flushing each step. */
async function typeUpTo(
  r: Repo,
  handle: DocHandle<TextDoc>,
  from: number,
  to: number
) {
  for (let i = from; i < to; i += STEP) {
    const step = changes.slice(i, Math.min(i + STEP, to))
    handle.update(d => A.applyChanges(d, step)[0])
    await r.flush([handle.documentId])
  }
}

describe("SubductionSource fragment upload", () => {
  it("compaction keeps the commits a fragment absorbed until the fragment is stored", async () => {
    // Skips the fragment's blob, as an E2EE interceptor does while it
    // has no key for the doc: its commits are stored, the fragment is not.
    let skipFragment = true
    const blobInterceptor: BlobInterceptor = {
      async transformOutgoing(_documentId, commitId, _parents, blob) {
        return skipFragment && commitId === fragmentHead ? null : blob
      },
      async transformIncoming(_documentId, _commitId, blob) {
        return blob
      },
    }
    const server = await startMeteredServer()
    cleanups.push(() => server.close())
    const storage = new DummyStorageAdapter()
    const alice = repo("alice", storage, { server, blobInterceptor })
    await awaitSubductionConnected(alice, { timeout: 5000 })
    const handle = alice.import<TextDoc>(A.save(typed(1)), {
      docId: nextDocId(),
    })
    const sid = toSedimentreeId(handle.documentId)
    const stored = async (kind: string) =>
      (
        await storage.loadRange([
          "subduction-interceptor",
          kind,
          sid.toString(),
        ])
      ).map(c => c.key[3])

    await typeUpTo(alice, handle, 1, N - STEP)
    // Compaction only runs once a round has succeeded.
    await waitFor(async () => {
      expect(await serverLoose(server, handle.documentId)).toBe(N - STEP)
    }, 20_000)
    const storedLoose = await stored("commits")
    expect(storedLoose).toHaveLength(N - STEP)
    // The step that forms the fragment, and one more, whose commits are
    // stored, which schedules a compaction.
    await expect(typeUpTo(alice, handle, N - STEP, N)).rejects.toThrow(
      /transformOutgoing returned null/
    )
    await expect(typeUpTo(alice, handle, N, N + STEP)).rejects.toThrow(
      /transformOutgoing returned null/
    )
    expect(A.getFragmentMetadata(handle.doc(), { start: 1 })).toHaveLength(1)
    await alice.shutdown()
    expect(await stored("fragments")).toEqual([])
    expect(await stored("commits")).toEqual(expect.arrayContaining(storedLoose))

    // Once the fragment is stored, compaction drops what it absorbed.
    skipFragment = false
    const online = repo("alice-online", storage, { server, blobInterceptor })
    await awaitSubductionConnected(online, { timeout: 5000 })
    const again = await online.find<TextDoc>(handle.url)
    again.change(d => A.splice(d, ["text"], d.text.length, 0, "!"))
    await online.flush([handle.documentId])
    await waitFor(async () => {
      const fragments = (await server.subduction.getFragments(sid)) ?? []
      expect(fragments.map(f => f.head.toHexString())).toEqual([fragmentHead])
    }, 20_000)
    // A round has succeeded, so the next save compacts.
    again.change(d => A.splice(d, ["text"], d.text.length, 0, "!"))
    await online.flush([handle.documentId])
    expect(await stored("fragments")).toEqual([fragmentHead])
    expect((await stored("commits")).length).toBe(
      A.getFragmentMetadata(again.doc(), 0).length
    )
  }, 60_000)
})
