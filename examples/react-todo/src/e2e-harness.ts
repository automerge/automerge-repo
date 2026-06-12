import {
  Repo,
  type AutomergeSignatureProvider,
  type AutomergeSigningRequest,
  type AutomergeVerificationRequest,
  type DocumentId,
  type PeerId,
} from "@automerge/automerge-repo/slim"
import {
  next as Automerge,
  initializeBase64Wasm,
} from "@automerge/automerge/slim"
// @ts-ignore — wasm-base64 has no type declarations
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64"
// @ts-ignore — initSync is not in the type declarations but is exported at runtime
import { initSync } from "@automerge/automerge-subduction/slim"
// @ts-ignore — wasm-base64 has no type declarations
import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"

interface TestDoc {
  title?: string
  accepted?: string
  rejected?: string
  forged?: string
}

type ScenarioResult = {
  beforeRevocation?: Partial<TestDoc>
  afterRevocation?: Partial<TestDoc>
  afterRejected?: Partial<TestDoc>
  rejectedVerifications: number
  acceptedVerifications: number
  missingSignatures: number
}

type TestIdentity = {
  author: string
  keyPair: CryptoKeyPair
}

type ConnectedRepos = {
  alice: Repo
  bob: Repo
  aliceProvider: BrowserSignatureProvider
  bobProvider: BrowserSignatureProvider
}

let initialized: Promise<void> | undefined

function ensureInitialized(): Promise<void> {
  initialized ??= (async () => {
    await initializeBase64Wasm(automergeWasmBase64)
    initSync({
      module: Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)),
    })
  })()
  return initialized
}

class BrowserSignatureProvider implements AutomergeSignatureProvider {
  acceptedVerifications = 0
  rejectedVerifications = 0
  readonly revoked = new Map<DocumentId, Set<string>>()

  constructor(private readonly signingKey: CryptoKey) {}

  revoke(documentId: DocumentId, author: string): void {
    let revokedForDoc = this.revoked.get(documentId)
    if (!revokedForDoc) {
      revokedForDoc = new Set()
      this.revoked.set(documentId, revokedForDoc)
    }
    revokedForDoc.add(author)
  }

  async sign(request: AutomergeSigningRequest): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        this.signingKey,
        request.bytesToSign as unknown as BufferSource
      )
    )
  }

  async verify(
    request: AutomergeVerificationRequest,
    documentId: DocumentId
  ): Promise<boolean> {
    const valid = await this.verifySignature(request)
    const revoked = this.revoked.get(documentId)?.has(request.author) ?? false
    const accepted = valid && !revoked

    if (accepted) {
      this.acceptedVerifications++
    } else {
      this.rejectedVerifications++
    }

    return accepted
  }

  private async verifySignature(
    request: AutomergeVerificationRequest
  ): Promise<boolean> {
    if (!request.signature) return false

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        hexToBytes(request.author) as unknown as BufferSource,
        "Ed25519",
        false,
        ["verify"]
      )
      return await crypto.subtle.verify(
        "Ed25519",
        key,
        request.signature as unknown as BufferSource,
        request.bytesToVerify as unknown as BufferSource
      )
    } catch {
      return false
    }
  }
}

async function createIdentity(_name: string): Promise<TestIdentity> {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey)
  )
  return {
    author: bytesToHex(publicKey),
    keyPair,
  }
}

function createSignedRepo(
  peerId: PeerId,
  identity: TestIdentity,
  provider = new BrowserSignatureProvider(identity.keyPair.privateKey)
): { repo: Repo; provider: BrowserSignatureProvider } {
  return {
    repo: new Repo({
      peerId,
      authorId: identity.author,
      signing: provider,
    }),
    provider,
  }
}

async function createConnectedRepos(): Promise<ConnectedRepos> {
  const aliceIdentity = await createIdentity("alice")
  const bobIdentity = await createIdentity("bob")
  const { repo: alice, provider: aliceProvider } = createSignedRepo(
    "alice" as PeerId,
    aliceIdentity
  )
  const { repo: bob, provider: bobProvider } = createSignedRepo(
    "bob" as PeerId,
    bobIdentity
  )
  return { alice, bob, aliceProvider, bobProvider }
}

// Deterministically move bytes between browser repos. This exercises Repo import
// and Automerge signature verification/materialization without depending on a
// public sync server.
function transferDoc<T>(
  source: { fullDoc(): Automerge.Doc<T>; documentId: DocumentId },
  target: Repo
) {
  return target.import<T>(Automerge.save(source.fullDoc()), {
    docId: source.documentId,
  })
}

async function waitForSigned(handle: { fullDoc(): Automerge.Doc<unknown> }) {
  await eventually(
    () => Automerge.missingSignatureHashes(handle.fullDoc()).length === 0
  )
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  let lastError: unknown

  while (performance.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }

  if (lastError) throw lastError
  throw new Error("timed out waiting for e2e condition")
}

function snapshot(handle: { doc(): TestDoc | undefined }): Partial<TestDoc> {
  const doc = handle.doc()
  return {
    title: doc?.title,
    accepted: doc?.accepted,
    rejected: doc?.rejected,
    forged: doc?.forged,
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`invalid hex string: ${hex}`)
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

async function revokedAuthorChangeIsNotMaterialized(): Promise<ScenarioResult> {
  await ensureInitialized()

  const { alice, bob, aliceProvider, bobProvider } =
    await createConnectedRepos()
  try {
    const aliceHandle = await alice.create2<TestDoc>({ title: "created" })
    await waitForSigned(aliceHandle)

    const bobHandle = transferDoc<TestDoc>(aliceHandle, bob)
    await eventually(() => bobHandle.doc()?.title === "created")

    bobHandle.change(doc => {
      doc.accepted = "bob-before-revocation"
    })
    await waitForSigned(bobHandle)
    transferDoc<TestDoc>(bobHandle, alice)
    await eventually(
      () => aliceHandle.doc()?.accepted === "bob-before-revocation"
    )

    const beforeRevocation = snapshot(aliceHandle)
    const bobAuthor = Automerge.getAuthor(bobHandle.fullDoc())!
    aliceProvider.revoke(aliceHandle.documentId, bobAuthor)

    bobHandle.change(doc => {
      doc.rejected = "bob-after-revocation"
    })
    await waitForSigned(bobHandle)
    transferDoc<TestDoc>(bobHandle, alice)
    await eventually(() => aliceProvider.rejectedVerifications > 0)

    return {
      beforeRevocation,
      afterRevocation: snapshot(aliceHandle),
      rejectedVerifications: aliceProvider.rejectedVerifications,
      acceptedVerifications: aliceProvider.acceptedVerifications,
      missingSignatures: Automerge.missingSignatureHashes(aliceHandle.fullDoc())
        .length,
    }
  } finally {
    bobProvider.revoked.clear()
    void alice.shutdown()
    void bob.shutdown()
  }
}

async function falselyAttributedChangeIsNotMaterialized(): Promise<ScenarioResult> {
  await ensureInitialized()

  const aliceIdentity = await createIdentity("alice")
  const malloryIdentity = await createIdentity("mallory")
  const { repo: alice, provider: aliceProvider } = createSignedRepo(
    "alice" as PeerId,
    aliceIdentity
  )

  const malloryProvider = new BrowserSignatureProvider(
    malloryIdentity.keyPair.privateKey
  )
  const { repo: mallory } = createSignedRepo(
    "mallory" as PeerId,
    aliceIdentity,
    malloryProvider
  )

  try {
    const aliceHandle = await alice.create2<TestDoc>({ title: "created" })
    await waitForSigned(aliceHandle)

    const malloryHandle = transferDoc<TestDoc>(aliceHandle, mallory)
    await eventually(() => malloryHandle.doc()?.title === "created")

    malloryHandle.change(doc => {
      doc.forged = "mallory-claiming-to-be-alice"
    })
    await waitForSigned(malloryHandle)
    transferDoc<TestDoc>(malloryHandle, alice)
    await eventually(() => aliceProvider.rejectedVerifications > 0)

    return {
      afterRejected: snapshot(aliceHandle),
      rejectedVerifications: aliceProvider.rejectedVerifications,
      acceptedVerifications: aliceProvider.acceptedVerifications,
      missingSignatures: Automerge.missingSignatureHashes(aliceHandle.fullDoc())
        .length,
    }
  } finally {
    void alice.shutdown()
    void mallory.shutdown()
  }
}

export const todoDemoE2E = {
  revokedAuthorChangeIsNotMaterialized,
  falselyAttributedChangeIsNotMaterialized,
}

declare global {
  interface Window {
    todoDemoE2E: typeof todoDemoE2E
  }
}

window.todoDemoE2E = todoDemoE2E
