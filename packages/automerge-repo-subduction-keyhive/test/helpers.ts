import * as A from "@automerge/automerge"
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo"
import {
  commitId,
  type LooseCommitRecord,
} from "@automerge/automerge-repo/sedimentree"
// Initializes Subduction's wasm module, which the backend uses through `slim`.
import "@automerge/subduction"
import {
  MemberedId,
  Power,
  type ContactCard,
  type GroupId,
  type Keyhive,
} from "@keyhive/keyhive/slim"
import { vi } from "vitest"
import { DummySubductionStorageAdapter } from "../../automerge-repo-subduction/src/helpers/DummySubductionStorageAdapter.js"
import {
  PairedTransport,
  connectBackends,
} from "../../automerge-repo-subduction/test/transport.js"
import { innerBackend } from "../src/KeyhiveBackend.js"
import type { LocalKeyhive } from "../src/LocalKeyhive.js"
import {
  KeyhiveBackend,
  initKeyhiveWasm,
  type KeyhiveBackendOptions,
} from "../src/index.js"

initKeyhiveWasm()

/** A peer whose Subduction and keyhive identities use the key in `storage`. */
export async function createPeer(
  storage = new DummySubductionStorageAdapter(),
  options?: Partial<KeyhiveBackendOptions>
) {
  const backend = await KeyhiveBackend.load({
    storage,
    syncTimeoutMilliseconds: 1000,
    ...options,
  })
  const inner = innerBackend(backend)
  return {
    signer: inner.signer(),
    keyhive: backend.keyhive().keyhive(),
    inner,
    backend,
    storage,
  }
}

/** A new group on `local` with the owner of `card` as a member. */
export async function groupWith(
  local: LocalKeyhive,
  card: ContactCard,
  power: Power
): Promise<GroupId> {
  const group = await local.generateGroup([])
  await local.receiveContactCard(card)
  await local.addMember(card.id, MemberedId.group(group), power)
  return group
}

export type TestPeer = Awaited<ReturnType<typeof createPeer>>

/** Connect two peers directly. */
export async function connect(a: TestPeer, b: TestPeer) {
  const wires = PairedTransport.pair()
  await connectBackends(
    { backend: a.backend, signer: a.signer },
    { backend: b.backend, signer: b.signer },
    wires
  )
  return { disconnect: () => wires[0].disconnect() }
}

/**
 * The document at `url` once it is ready. Unlike `find`, this keeps waiting
 * while the document is unavailable, e.g., until a new member's access has
 * reached the server.
 */
export function whenReady<T>(
  repo: Repo,
  url: AutomergeUrl,
  timeoutMs = 20000
): Promise<DocHandle<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${url} was not ready after ${timeoutMs} ms`)),
      timeoutMs
    )
    const unsubscribe = repo.query<T>(url).subscribe(state => {
      if (state.status !== "ready") return
      clearTimeout(timer)
      queueMicrotask(() => unsubscribe())
      resolve(state.handle)
    })
  })
}

/** A commit record setting `text` in `doc`, which its Repo has not seen. */
export function unseenCommit(
  doc: A.Doc<{ text: string }>,
  text = "unseen"
): LooseCommitRecord {
  const next = A.change(A.clone(doc), note => {
    note.text = text
  })
  const blob = A.getLastLocalChange(next)!
  const change = A.decodeChange(blob)
  return {
    kind: "commit",
    id: commitId(change.hash),
    parents: change.deps.map(commitId).sort(),
    blob,
  }
}

/**
 * Make `keyhive` report Read on every document, so a replica that holds none
 * of a document's keys still retries its pending records, as a member whose
 * keys have not arrived does.
 */
export function readerWithoutKeys(keyhive: Keyhive) {
  vi.spyOn(keyhive, "accessForDoc").mockImplementation(async () => Power.read())
}
