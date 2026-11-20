import * as A from "@automerge/automerge"
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo"
import {
  commitId,
  type LooseCommitRecord,
} from "@automerge/automerge-repo/sedimentree"
import { changesIn } from "@automerge/automerge-repo/sedimentree/automerge"
import * as N from "@automerge/subduction"
import { type Keyhive, Power, Signer } from "@keyhive/keyhive/slim"
import { vi } from "vitest"
import { DummySubductionStorageAdapter } from "../../automerge-repo-subduction/src/helpers/DummySubductionStorageAdapter.js"
import {
  PairedTransport,
  connectBackends,
} from "../../automerge-repo-subduction/test/transport.js"
import { innerBackend } from "../src/KeyhiveBackend.js"
import {
  KeyhiveBackend,
  LocalKeyhive,
  initKeyhiveWasm,
  type KeyhiveBackendOptions,
} from "../src/index.js"

initKeyhiveWasm()

export function generateKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>
}

/** A peer whose Subduction and keyhive identities use the same key. */
export async function createPeer(
  keys?: CryptoKeyPair,
  storage = new DummySubductionStorageAdapter(),
  options?: Partial<KeyhiveBackendOptions>
) {
  const pair = keys ?? (await generateKeys())
  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey)
  const signer = N.createMemorySigner(
    new Uint8Array(Buffer.from(d!, "base64url"))
  )
  const local = await LocalKeyhive.open(
    await Signer.webCryptoSigner(pair),
    storage
  )
  const backend = new KeyhiveBackend(local, {
    storage,
    signer,
    syncTimeoutMilliseconds: 1000,
    changesIn,
    ...options,
  })
  return {
    signer,
    keyhive: local.keyhive,
    inner: innerBackend(backend),
    backend,
    keys: pair,
    storage,
  }
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
