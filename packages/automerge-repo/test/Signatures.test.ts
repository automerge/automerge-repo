import { next as A } from "@automerge/automerge"
import assert from "assert"
import { describe, expect, it } from "vitest"
import { Repo, type AutomergeSignatureProvider } from "../src/Repo.js"
import type {
  AutomergeSigningRequest,
  AutomergeVerificationRequest,
} from "../src/Repo.js"
import type { DocHandle } from "../src/DocHandle.js"
import type { DocumentId, PeerId } from "../src/types.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import { pause } from "../src/helpers/pause.js"
import connectRepos from "./helpers/connectRepos.js"

const ALICE = "01".repeat(32)
const BOB = "02".repeat(32)

type TestDoc = { value?: string }

type PendingSigning = {
  request: AutomergeSigningRequest
  documentId: DocumentId
  resolve: (signature: Uint8Array) => void
}

class DeferredSignatureProvider implements AutomergeSignatureProvider {
  #signingPaused = false
  readonly signingRequests: Array<{
    request: AutomergeSigningRequest
    documentId: DocumentId
  }> = []
  readonly verificationRequests: Array<{
    request: AutomergeVerificationRequest
    documentId: DocumentId
    accepted: boolean
  }> = []
  readonly pendingSigning: PendingSigning[] = []

  pauseSigning() {
    this.#signingPaused = true
  }

  resumeSigning() {
    this.#signingPaused = false
    this.releaseAll()
  }

  async sign(
    request: AutomergeSigningRequest,
    documentId: DocumentId
  ): Promise<Uint8Array> {
    this.signingRequests.push({ request, documentId })
    if (!this.#signingPaused) return signatureFor(request)

    return new Promise(resolve => {
      this.pendingSigning.push({ request, documentId, resolve })
    })
  }

  async verify(
    request: AutomergeVerificationRequest,
    documentId: DocumentId
  ): Promise<boolean> {
    const accepted =
      request.signature !== undefined &&
      bytesEqual(request.signature, signatureFor(request))
    this.verificationRequests.push({ request, documentId, accepted })
    return accepted
  }

  releaseNext(): AutomergeSigningRequest {
    const pending = this.pendingSigning.shift()
    assert.ok(pending, "expected a pending signing request")
    pending.resolve(signatureFor(pending.request))
    return pending.request
  }

  releaseAll() {
    while (this.pendingSigning.length > 0) this.releaseNext()
  }
}

function signatureFor(request: {
  author: string
  hash: string
  bytesToSign?: Uint8Array
  bytesToVerify?: Uint8Array
}): Uint8Array {
  return new TextEncoder().encode(`${request.author}:${request.hash}`)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await pause(10)
  }
  throw new Error(message)
}

async function waitForSigned(handle: DocHandle<unknown>) {
  await waitFor(
    () => A.missingSignatureHashes(handle.fullDoc()).length === 0,
    "document still has missing signatures"
  )
}

function signedRepo(
  peerId: PeerId,
  author: string,
  provider = new DeferredSignatureProvider(),
  options: Partial<ConstructorParameters<typeof Repo>[0]> = {}
) {
  return {
    provider,
    repo: new Repo({
      peerId,
      authorId: author,
      signing: provider,
      ...options,
    }),
  }
}

describe("Repo Automerge signatures", () => {
  it("emits a follow-up heads-changed and exports the change after slow signing completes", async () => {
    const { repo, provider } = signedRepo("alice" as PeerId, ALICE)

    try {
      const handle = repo.create<TestDoc>({ value: "baseline" })
      await waitForSigned(handle)
      const baselineHeads = A.getHeads(handle.fullDoc())

      provider.pauseSigning()
      let headsChangedCount = 0
      const secondHeadsChanged = new Promise<void>(resolve => {
        handle.on("heads-changed", () => {
          headsChangedCount++
          if (headsChangedCount === 2) resolve()
        })
      })

      handle.change(doc => {
        doc.value = "after-slow-sign"
      })

      const unsignedHeads = A.missingSignatureHashes(handle.fullDoc())
      expect(unsignedHeads).toHaveLength(1)
      expect(A.getChangesSince(handle.fullDoc(), baselineHeads)).toHaveLength(0)
      expect(headsChangedCount).toBe(1)

      await waitFor(
        () => provider.pendingSigning.length === 1,
        "signing request was not queued"
      )
      provider.releaseNext()

      await secondHeadsChanged
      await waitForSigned(handle)

      expect(headsChangedCount).toBeGreaterThanOrEqual(2)
      expect(A.getChangesSince(handle.fullDoc(), baselineHeads)).toHaveLength(1)
    } finally {
      await repo.shutdown()
    }
  })

  it("legacy sync does not send unsigned changes, then sends them after signing", async () => {
    const { repo: alice, provider: aliceProvider } = signedRepo(
      "alice" as PeerId,
      ALICE
    )
    const { repo: bob, provider: bobProvider } = signedRepo(
      "bob" as PeerId,
      BOB
    )

    try {
      await connectRepos(alice, bob)

      const aliceHandle = alice.create<TestDoc>({ value: "baseline" })
      await waitForSigned(aliceHandle)
      const bobHandle = await bob.find<TestDoc>(aliceHandle.url)
      await waitFor(
        () => bobHandle.doc()?.value === "baseline",
        "Bob did not receive signed baseline"
      )

      aliceProvider.pauseSigning()
      const baselineHeads = A.getHeads(aliceHandle.fullDoc())
      aliceHandle.change(doc => {
        doc.value = "signed-after-delay"
      })
      const [unsignedHead] = A.missingSignatureHashes(aliceHandle.fullDoc())
      expect(unsignedHead).toBeDefined()
      expect(
        A.getChangesSince(aliceHandle.fullDoc(), baselineHeads)
      ).toHaveLength(0)

      await waitFor(
        () => aliceProvider.pendingSigning.length === 1,
        "Alice did not queue the slow signing request"
      )
      await pause(150)

      expect(bobHandle.doc()?.value).toBe("baseline")
      expect(
        bobProvider.verificationRequests.some(
          ({ request }) => request.hash === unsignedHead
        )
      ).toBe(false)

      aliceProvider.releaseNext()

      await waitFor(
        () => bobHandle.doc()?.value === "signed-after-delay",
        "Bob did not receive the change after its signature attached"
      )
      const verification = bobProvider.verificationRequests.find(
        ({ request }) => request.hash === unsignedHead
      )
      expect(verification?.request.signature).toBeDefined()
      expect(verification?.accepted).toBe(true)
    } finally {
      await Promise.all([alice.shutdown(), bob.shutdown()])
    }
  })

  it("storage does not save or advance past unsigned changes", async () => {
    const storage = new DummyStorageAdapter()
    const { repo: writer, provider: writerProvider } = signedRepo(
      "writer" as PeerId,
      ALICE,
      undefined,
      { storage, saveDebounceRate: 1 }
    )
    const readers: Repo[] = []

    try {
      const handle = writer.create<TestDoc>({ value: "baseline" })
      await waitForSigned(handle)
      await writer.flush()

      writerProvider.pauseSigning()
      handle.change(doc => {
        doc.value = "after-slow-sign"
      })
      await waitFor(
        () => writerProvider.pendingSigning.length === 1,
        "writer did not queue the slow signing request"
      )

      await writer.flush()

      const beforeRelease = new Repo({ storage })
      readers.push(beforeRelease)
      const beforeHandle = await beforeRelease.find<TestDoc>(handle.url)
      await waitFor(
        () => beforeHandle.doc()?.value === "baseline",
        "unsigned change was saved before its signature attached"
      )
      expect(beforeHandle.doc()?.value).toBe("baseline")

      writerProvider.releaseNext()
      await waitForSigned(handle)
      await writer.flush()

      const afterRelease = new Repo({ storage })
      readers.push(afterRelease)
      const afterHandle = await afterRelease.find<TestDoc>(handle.url)
      await waitFor(
        () => afterHandle.doc()?.value === "after-slow-sign",
        "signed change was not saved after its signature attached"
      )
    } finally {
      await Promise.all([writer.shutdown(), ...readers.map(r => r.shutdown())])
    }
  })

  it("subduction persistence skips unsigned changes and persists once signing completes", async () => {
    const outgoingBlobs: Uint8Array[] = []
    const { repo, provider } = signedRepo("alice" as PeerId, ALICE, undefined, {
      subductionBlobInterceptor: {
        async transformOutgoing(_documentId, blob) {
          outgoingBlobs.push(blob)
          return blob
        },
        async transformIncoming(_documentId, blob) {
          return blob
        },
      },
    })

    try {
      const handle = repo.create<TestDoc>({ value: "baseline" })
      await waitForSigned(handle)
      await repo.flush([handle.documentId])
      outgoingBlobs.length = 0

      provider.pauseSigning()
      handle.change(doc => {
        doc.value = "after-slow-sign"
      })
      await waitFor(
        () => provider.pendingSigning.length === 1,
        "subduction test did not queue the slow signing request"
      )
      await pause(250)
      expect(outgoingBlobs).toHaveLength(0)

      provider.releaseNext()
      await waitForSigned(handle)
      await waitFor(
        () => outgoingBlobs.length > 0,
        "subduction did not persist the change after signing completed"
      )
    } finally {
      await repo.shutdown()
    }
  })
})
