import {
  BackendError,
  copyRecord,
  commitId,
  idBytes,
  headsOf,
  provides,
  type ExtensionsOf,
  recordHead,
  sedimentreeId,
  type CommitId,
  type RecordBatch,
  type SedimentreeBackend,
  type SedimentreeId,
  type SedimentreeRecord,
  type Signer,
} from "@automerge/automerge-repo/sedimentree"
import {
  ephemeral,
  SubductionBackend,
  type SubductionBackendOptions,
  type Transport,
  type TransportAudience,
} from "@automerge/automerge-repo-subduction"
import { createMemorySigner } from "@automerge/subduction/slim"
import {
  ChangeId,
  DocumentId,
  Encrypted,
  Identifier,
  type Keyhive,
  Power,
  Signer as KeyhiveSigner,
} from "@keyhive/keyhive/slim"
import { keyhive } from "./extension.js"
import {
  contentRef,
  DocumentRefs,
  recordRef,
  refBytes,
  storedRef,
  type ContentRef,
} from "./DocumentRefs.js"
import {
  KeyhiveSession,
  pendingHead,
  predecessors,
  type LoadBlob,
  type PendingRecord,
} from "./KeyhiveSession.js"
import { RelayGrants } from "./RelayGrants.js"
import { LocalKeyhive, type StoredHeads } from "./LocalKeyhive.js"
import { KeyhiveStorage } from "./KeyhiveStorage.js"
import { KeyhiveSync, type KeyhiveSyncOptions } from "./KeyhiveSync.js"
import { log } from "./logging.js"
import { freeAfter, freeAll, Rerun } from "./utilities.js"
import type { PromiseQueue } from "./PromiseQueue.js"

/**
 * The options of the inner {@link SubductionBackend}, except its signer,
 * keyhive and document IDs, which {@link KeyhiveBackend} supplies, plus the
 * keyhive sync intervals and the sync servers to grant Relay.
 */
export interface KeyhiveBackendOptions
  extends
    Omit<SubductionBackendOptions, "signer" | "keyhive" | "mintDocumentId">,
    Pick<KeyhiveSyncOptions, "syncIntervalMs" | "backupSyncIntervalMs"> {
  /**
   * This replica's 32-byte Ed25519 secret key, which signs for it in both
   * keyhive and Subduction. If it is omitted, the key in `storage` is used,
   * or a new one is generated and saved there. A key passed here is not
   * saved, so pass it on every load. {@link KeyhiveBackend.load} rejects if
   * it is not the key of the keyhive in `storage`.
   */
  signingKey?: Uint8Array
  /**
   * The 32-byte verifying keys of the sync servers granted Relay on every
   * document this replica can reach. They are not stored and need to be
   * passed in on each start. The constructor throws if one is not 32 bytes.
   */
  relays?: readonly Uint8Array[]
}

let innerOf: (backend: KeyhiveBackend) => SubductionBackend

/**
 * The inner backend of `backend` for this package's tests. It is not exported
 * from the package because a record stored through it is not encrypted.
 */
export function innerBackend(backend: KeyhiveBackend): SubductionBackend {
  return innerOf(backend)
}

/** What a `KeyhiveBackend`'s extensions add to the handles of a Repo on it. */
export type KeyhiveExtensions = ExtensionsOf<KeyhiveBackend>

/**
 * A sedimentree backend that encrypts a {@link SubductionBackend}'s content
 * with keyhive. Connect it to peers with the `network` option or with
 * {@link KeyhiveBackend.addConnection} and {@link KeyhiveBackend.acceptConnection}.
 */
export class KeyhiveBackend implements SedimentreeBackend {
  static {
    innerOf = backend => backend.#inner
  }

  /**
   * Stores and syncs the ciphertext. Also runs keyhive sync with its peers.
   * Private because a record stored through it directly is not encrypted.
   */
  readonly #inner: SubductionBackend
  /**
   * Every handle of a Repo on this backend has `handle.keyhive()` and
   * Subduction's ephemeral messaging. Ephemeral messages are not encrypted.
   */
  readonly handleExtensions = provides(ephemeral, keyhive)
  /** Keeps keyhive calls exclusive and in submission order. */
  readonly #queue: PromiseQueue
  /**
   * Content refs of each document written or opened. A document's own writes
   * are forgotten when its last session closes. A later session decrypts
   * them like any other record. Its fragments are kept because later writes
   * list them as predecessors. They are also kept while no session is open.
   */
  readonly #refs = new Map<SedimentreeId, DocumentRefs>()
  readonly #sessions = new Set<KeyhiveSession>()
  /**
   * Stores whose records cannot all be encrypted yet, oldest first. They are
   * only in memory. Each store's promise is resolved once it is stored.
   */
  readonly #waiting = new Map<SedimentreeId, WaitingStore[]>()

  readonly #local: LocalKeyhive
  /** The keyhive inside {@link keyhive}. Call it only inside its queue. */
  readonly #keyhive: Keyhive
  readonly #relayGrants: RelayGrants
  /** Retries of pending records and waiting stores after keyhive state arrives. */
  readonly #retries = new Rerun(async () => {
    await this.#retrySessions()
    await this.#retryWaiting()
  })
  /** Sedimentree sync rounds, by document. */
  readonly #resyncs = new Rerun<SedimentreeId>(id =>
    this.#inner
      .syncDocument(id)
      .catch(error => log.warn("[KeyhiveBackend] resync failed:", error))
  )
  #closed = false
  readonly #sync: KeyhiveSync
  readonly #storedHeads: StoredHeads = async id =>
    ((await this.#inner.subduction.getHeads(id)) ?? []).map(commitId)

  /**
   * Load this replica's signing key and keyhive from `options.storage`, or
   * create them, then build the backend and start keyhive sync with its
   * peers (`close` stops sync). Rejects with keyhive's `TryFromArchiveError`
   * if `options.signingKey` is not the key of the keyhive in storage and
   * with a `RangeError` if a sync interval is not positive.
   */
  static async load(options: KeyhiveBackendOptions): Promise<KeyhiveBackend> {
    for (const ms of [options.syncIntervalMs, options.backupSyncIntervalMs]) {
      if (ms != null && !(ms > 0)) {
        throw new RangeError(`sync intervals must be positive, not ${ms}`)
      }
    }
    const key =
      options.signingKey ??
      (await new KeyhiveStorage(options.storage).loadOrCreateSigningKey())
    let backend: KeyhiveBackend | undefined
    const local = await LocalKeyhive.open(
      KeyhiveSigner.memorySignerFromBytes(key),
      options.storage,
      id => backend!.#storedHeads(id)
    )
    backend = new KeyhiveBackend(local, createMemorySigner(key), options)
    return backend
  }

  private constructor(
    local: LocalKeyhive,
    signer: NonNullable<SubductionBackendOptions["signer"]>,
    options: KeyhiveBackendOptions
  ) {
    const {
      relays = [],
      syncIntervalMs,
      backupSyncIntervalMs,
      signingKey: _,
      ...subduction
    } = options
    this.#inner = new SubductionBackend({
      ...subduction,
      signer,
      keyhive: local.access(),
    })
    this.#local = local
    this.#keyhive = local.keyhive()
    this.#queue = local.queue
    this.#relayGrants = new RelayGrants(local, relays)
    this.#sync = new KeyhiveSync({
      inner: this.#inner,
      local,
      onIngest: () => this.#afterKeyhiveChange(),
      onDelivered: () => this.#resyncSessions(),
      onFrame: () => {
        this.#relayGrants.retry()
        // The resync after this replica's own ingest can reach a server that
        // cannot serve the document yet: it has not ingested the writer's
        // grant or accepted the writer's upload. Keep trying while connected.
        this.#resyncLoading()
      },
      syncIntervalMs,
      backupSyncIntervalMs,
      onBackup: () => {
        this.#retry()
        this.#resyncSessions()
      },
    })
  }

  /** This replica's keyhive. */
  keyhive(): LocalKeyhive {
    return this.#local
  }

  create(
    initialRecords: RecordBatch,
    options?: { documentId?: SedimentreeId }
  ): Promise<SedimentreeId> {
    if (options?.documentId) {
      return Promise.reject(
        new BackendError(
          "create",
          "unsupported",
          "Keyhive generates document IDs"
        )
      )
    }
    let records: SedimentreeRecord[]
    try {
      records = this.#accept("create", initialRecords)
    } catch (error) {
      return Promise.reject(error)
    }
    const heads = headsOf(records)
    if (heads.length === 0) {
      return Promise.reject(
        new BackendError(
          "create",
          "unsupported",
          "A keyhive document needs at least one initial record"
        )
      )
    }
    return this.#queue.run(async () => {
      const documentId = await this.#generateDocument(heads)
      const id = sedimentreeId(documentId.toBytes())
      await this.#relayGrants.grantNew(id)
      const encrypted = await this.#encryptAll(id, records)
      await this.#local.persist()
      return this.#inner.create(encrypted, { documentId: id })
    })
  }

  open(id: SedimentreeId): KeyhiveSession {
    const session: KeyhiveSession = new KeyhiveSession(
      id,
      this.#inner.open(id),
      {
        local: this.#local,
        decrypt: (encrypted, load) => this.#causalDecrypt(id, encrypted, load),
        loadBlob: this.#blobLoader(id),
        atMostRelay: () => this.#atMostRelay(id),
        refs: this.#refsOf(id),
        onClose: () => {
          this.#sessions.delete(session)
          if (!this.#isOpen(id)) this.#refs.get(id)?.dropOwnWrites()
        },
      }
    )
    this.#sessions.add(session)
    return session
  }

  /**
   * Resolves once `batch` is encrypted and stored. While keyhive cannot
   * encrypt it yet, e.g., while this replica has no access, it waits in
   * memory behind any earlier store of the document. It is tried again when
   * keyhive state arrives from a peer, on each backup sync, and when the
   * document is stored again. Nothing waiting survives a restart.
   */
  store(id: SedimentreeId, batch: RecordBatch): Promise<void> {
    let records: SedimentreeRecord[]
    try {
      records = this.#accept("store", batch)
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise((resolve, reject) => {
      const waiting = this.#waiting.get(id) ?? []
      waiting.push({ records, encrypted: [], waited: false, resolve, reject })
      this.#waiting.set(id, waiting)
      this.#queue.run(() => this.#sendWaiting(id)).catch(reject)
    })
  }

  /** Check that the backend is open, then validate and copy `records`. */
  #accept(
    operation: "create" | "store",
    records: RecordBatch
  ): SedimentreeRecord[] {
    if (this.#closed)
      throw new BackendError(operation, "closed", "Backend is closed")
    try {
      return records.map(copyRecord)
    } catch (cause) {
      throw new BackendError(
        operation,
        "invalid-record",
        String(cause),
        false,
        {
          cause,
        }
      )
    }
  }

  /**
   * Authenticate an outgoing transport and add the connection. Resolves to
   * the remote peer ID. See {@link SubductionBackend.addConnection}.
   */
  addConnection(
    transport: Transport,
    audience: TransportAudience
  ): Promise<string> {
    return this.#inner.addConnection(transport, audience)
  }

  /** The accepting side of {@link KeyhiveBackend.addConnection}. */
  acceptConnection(
    transport: Transport,
    audience: TransportAudience
  ): Promise<string> {
    return this.#inner.acceptConnection(transport, audience)
  }

  /**
   * Grant Relay to this sync server on every document this replica can reach,
   * now and later, once keyhive knows the server. It is not stored. Add it
   * again on each start. Throws if `verifyingKey` is not 32 bytes.
   */
  addRelay(verifyingKey: Uint8Array): void {
    this.#relayGrants.add(verifyingKey)
  }

  /**
   * The number of received records of `id` that open sessions cannot decrypt
   * yet. Local writes that cannot be encrypted yet are not counted.
   */
  pendingCount(id: SedimentreeId): number {
    let count = 0
    for (const session of this.#sessions) {
      if (session.id === id) count += session.pendingCount
    }
    return count
  }

  /** This replica's signer, which is its keyhive key, for every document. */
  signer(id?: SedimentreeId): Signer {
    return this.#inner.signer(id)
  }

  /** Start a full keyhive sync round with each connected peer now. */
  syncKeyhive(): void {
    this.#sync.sync()
  }

  /**
   * Flush the inner backend, then reject with a retryable error if a store of
   * one of `ids` (of any document if `ids` is omitted) is still waiting to be
   * encrypted, since its records are not durable. A waiting store can still succeed, e.g., once
   * a revoked member is added again, so it is neither waited for nor failed.
   */
  async flush(ids?: readonly SedimentreeId[]): Promise<void> {
    await this.#queue.run(async () => {})
    await this.#inner.flush(ids)
    const waiting = [...this.#waiting.keys()].filter(
      id => !ids || ids.includes(id)
    )
    if (waiting.length > 0) {
      throw new BackendError(
        "flush",
        "io",
        `Writes to ${waiting.length} document(s) are waiting for keyhive to encrypt them`,
        true
      )
    }
  }

  async deleteLocal(id: SedimentreeId): Promise<void> {
    await this.#queue.run(async () => {
      this.#failWaiting(
        id,
        new BackendError("store", "deleted", "The document was deleted")
      )
      this.#refs.delete(id)
    })
    await this.#inner.deleteLocal(id)
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#sync.close()
    this.#relayGrants.close()
    try {
      await this.#queue.run(async () => {
        for (const id of [...this.#waiting.keys()]) {
          this.#failWaiting(
            id,
            new BackendError("store", "closed", "Backend is closed")
          )
        }
        await this.#local.persist()
        await this.#local.storage.saveArchive(this.#keyhive)
      })
    } finally {
      await this.#inner.close()
    }
  }

  /** A keyhive document with this replica as its only admin. */
  #generateDocument(heads: readonly CommitId[]): Promise<DocumentId> {
    const [first, ...rest] = heads.map(changeId)
    return this.#keyhive.generateDocument([], first, rest)
  }

  #isOpen(id: SedimentreeId): boolean {
    for (const session of this.#sessions) if (session.id === id) return true
    return false
  }

  #refsOf(id: SedimentreeId): DocumentRefs {
    let refs = this.#refs.get(id)
    if (!refs) {
      refs = new DocumentRefs()
      this.#refs.set(id, refs)
    }
    return refs
  }

  async #encryptAll(
    id: SedimentreeId,
    batch: RecordBatch
  ): Promise<SedimentreeRecord[]> {
    const refs = this.#refsOf(id)
    const encrypted: SedimentreeRecord[] = []
    for (const record of batch) {
      const { blob, ref } = await this.#encrypt(id, record)
      refs.addOwnWrite(ref)
      encrypted.push({ ...record, blob })
    }
    return encrypted
  }

  /**
   * Encrypt and store the waiting stores of `id` in order until one cannot be
   * encrypted yet. A store stays first in the list until all its records are
   * encrypted. The stores encrypted in a row go to the inner backend in one
   * batch since Subduction updates the tree once for each store. Stores
   * added while this runs are sent in the same pass.
   */
  async #sendWaiting(id: SedimentreeId): Promise<void> {
    const waiting = this.#waiting.get(id)
    const isStored = this.#storedChecker(id)
    while (waiting?.length) {
      const ready: WaitingStore[] = []
      let blocked = false
      while (waiting.length > 0) {
        if (!(await this.#encryptStore(id, waiting[0], isStored))) {
          blocked = true
          break
        }
        ready.push(waiting.shift()!)
      }
      if (ready.length > 0 && !(await this.#sendStores(id, ready))) return
      if (blocked) return
    }
    this.#waiting.delete(id)
  }

  /**
   * Encrypt the records of `store` not encrypted yet. Each one is kept so a
   * retry continues where this stopped. Returns `false` if the store has to
   * wait or if an error other than keyhive refusing to encrypt rejected it
   * and every later store of `id`.
   *
   * A fragment that the inner backend already stores under its ref is not
   * encrypted again. Encrypting replaces keyhive's key for the ref and the
   * new key would not open the stored ciphertext. Repo can store a fragment
   * it has stored before.
   */
  async #encryptStore(
    id: SedimentreeId,
    store: WaitingStore,
    isStored: (record: SedimentreeRecord) => Promise<boolean>
  ): Promise<boolean> {
    try {
      for (const record of store.records.slice(store.encrypted.length)) {
        if (record.kind === "fragment" && (await isStored(record))) {
          store.encrypted.push(undefined)
          continue
        }
        const { blob, ref } = await this.#encrypt(id, record)
        store.encrypted.push({ record: { ...record, blob }, ref })
      }
      return true
    } catch (error) {
      if (!(error instanceof CannotEncryptYet)) {
        this.#failWaiting(id, error)
        return false
      }
      if (!store.waited) {
        log.warn(
          "[KeyhiveBackend] a write waits until keyhive can encrypt it:",
          error.cause
        )
      }
      store.waited = true
      return false
    }
  }

  /**
   * Persist keyhive state, then pass the ciphertext of `stores` to the inner
   * backend in one batch and resolve them. Returns `false` if that failed,
   * which rejects them and every later store of `id`.
   */
  async #sendStores(
    id: SedimentreeId,
    stores: readonly WaitingStore[]
  ): Promise<boolean> {
    const records: SedimentreeRecord[] = []
    for (const store of stores) {
      const encrypted = store.encrypted.filter(e => e !== undefined)
      if (!store.waited && this.#isOpen(id)) {
        for (const { ref } of encrypted) this.#refsOf(id).addOwnWrite(ref)
      }
      records.push(...encrypted.map(({ record }) => record))
    }
    try {
      await this.#local.persist()
      if (records.length > 0) await this.#inner.store(id, records)
    } catch (error) {
      for (const store of stores) store.reject(error)
      this.#failWaiting(id, error)
      return false
    }
    for (const store of stores) store.resolve()
    return true
  }

  /** Reject every waiting store of `id`. */
  #failWaiting(id: SedimentreeId, error: unknown): void {
    for (const waiting of this.#waiting.get(id) ?? []) waiting.reject(error)
    this.#waiting.delete(id)
  }

  /**
   * A check of whether the inner backend stores a ciphertext of a record
   * under the record's ref. It reads the stored records' digests once, on
   * first use. Records encrypted earlier in this pass, or still held
   * encrypted by a waiting store, count as stored.
   */
  #storedChecker(
    id: SedimentreeId
  ): (record: SedimentreeRecord) => Promise<boolean> {
    let digests: Promise<Map<string, string>> | undefined
    const encrypting = new Set(
      (this.#waiting.get(id) ?? []).flatMap(store =>
        store.encrypted.flatMap(e =>
          e ? [`${e.record.kind}:${recordHead(e.record)}`] : []
        )
      )
    )
    return async record => {
      const key = `${record.kind}:${recordHead(record)}`
      if (encrypting.has(key)) return true
      digests ??= this.#readDigests(id)
      const digest = (await digests).get(key)
      const stored =
        digest === undefined
          ? undefined
          : await this.#inner.subduction.getBlob(id, digest)
      if (stored !== undefined && storedRef(stored) === recordRef(record))
        return true
      encrypting.add(key)
      return false
    }
  }

  /**
   * Encrypt `record` under its content ref. Each predecessor commit (a
   * commit's parents or a fragment's boundary commits) is listed as the
   * deepest known fragment that contains it or else as itself if keyhive
   * has its key. One with neither is left out because listing it would fail
   * the write. A reader then cannot reach it through this record, but a
   * member can still decrypt it with a key from the document's CGKA group.
   * Throws if keyhive cannot encrypt for this document yet.
   */
  async #encrypt(
    id: SedimentreeId,
    record: SedimentreeRecord
  ): Promise<{ blob: Uint8Array; ref: ContentRef }> {
    const refs = this.#refsOf(id)
    const ref = recordRef(record)
    return freeAfter(new DocumentId(idBytes(id)), async document => {
      const predecessorRefs = new Set<ContentRef>()
      for (const commit of predecessors(record)) {
        const fragment = refs.fragments.deepestContaining(commit)
        if (fragment) predecessorRefs.add(fragment)
        else if (
          await freeAfter(changeId(commit), c =>
            this.#keyhive.hasKeyFor(document, c)
          )
        ) {
          predecessorRefs.add(commit as string as ContentRef)
        }
      }
      const contentRef = new ChangeId(refBytes(ref))
      const predecessorIds = [...predecessorRefs].map(
        p => new ChangeId(refBytes(p))
      )
      const encrypted = await this.#keyhive
        .tryEncrypt(document, contentRef, predecessorIds, record.blob)
        .catch(error => {
          throw new CannotEncryptYet(error)
        })
        .finally(() => freeAll([contentRef, ...predecessorIds]))
      const content = encrypted.encryptedContent()
      const blob = content.toBytes()
      freeAll([content, encrypted])
      if (record.kind === "fragment") refs.fragments.add(ref, record)
      return { blob, ref }
    })
  }

  /**
   * Reads ciphertext from the inner backend by the digest its metadata records
   * for the head. The digests are read again when a head is not found or its
   * no blob is found for the digest, which happens once the inner backend
   * replaces the head's record.
   */
  #blobLoader(id: SedimentreeId): LoadBlob {
    let digests = new Map<string, string>()
    const key = (record: PendingRecord) =>
      `${record.kind}:${pendingHead(record)}`
    const load = (record: PendingRecord) => {
      const digest = digests.get(key(record))
      return digest === undefined
        ? undefined
        : this.#inner.subduction.getBlob(id, digest)
    }
    return async record => {
      const cached = digests.has(key(record)) ? await load(record) : undefined
      if (cached) return cached
      digests = await this.#readDigests(id)
      return load(record)
    }
  }

  async #readDigests(id: SedimentreeId): Promise<Map<string, string>> {
    const { subduction } = this.#inner
    const [commits, fragments] = await Promise.all([
      subduction.getCommits(id),
      subduction.getFragments(id),
    ])
    return new Map([
      ...(commits ?? []).map(
        c => [`commit:${commitId(c.head)}`, c.blobMeta.digest] as const
      ),
      ...(fragments ?? []).map(
        f => [`fragment:${commitId(f.head)}`, f.blobMeta.digest] as const
      ),
    ])
  }

  #atMostRelay(sedimentreeId: SedimentreeId): Promise<boolean> {
    return this.#queue.run(async () => {
      const keyhiveId = new Identifier(this.#keyhive.id.toBytes())
      const doc = new DocumentId(idBytes(sedimentreeId))
      const read = Power.read()
      const owned: { free(): void }[] = [keyhiveId, doc, read]
      try {
        const power = await this.#keyhive.accessForDoc(keyhiveId, doc)
        if (power) owned.push(power)
        return power === undefined || power.compareTo(read) < 0
      } finally {
        freeAll(owned)
      }
    })
  }

  #causalDecrypt(
    id: SedimentreeId,
    encrypted: Encrypted,
    load: (ref: ContentRef) => Promise<Uint8Array | undefined> | undefined
  ): Promise<{ ref: ContentRef; plaintext: Uint8Array }[]> {
    return this.#queue.run(async () => {
      const decryption = await freeAfter(new DocumentId(idBytes(id)), doc =>
        this.#keyhive.tryCausalDecrypt(doc, encrypted, (ref: ChangeId) => {
          const bytes = ref.toBytes()
          ref.free()
          return load(contentRef(bytes))
        })
      )
      const blocks = decryption.complete()
      decryption.free()
      return blocks.map(block => {
        const ref = block.contentRef
        const opened = {
          ref: contentRef(ref.toBytes()),
          plaintext: block.content(),
        }
        freeAll([ref, block])
        return opened
      })
    })
  }

  #afterKeyhiveChange(): void {
    this.#retry()
    this.#resyncLoading()
  }

  #retry(): void {
    if (this.#closed) return
    this.#retries.run()
  }

  async #retryWaiting(): Promise<void> {
    if (this.#closed) return
    await Promise.all(
      [...this.#waiting.keys()].map(id =>
        this.#queue
          .run(() => this.#sendWaiting(id))
          .catch(error =>
            log.error("[KeyhiveBackend] waiting store failed:", error)
          )
      )
    )
  }

  /**
   * Run a sedimentree sync round for each open document that Repo has not
   * marked ready, after keyhive state has arrived that may let this replica
   * read it.
   *
   * Which documents a keyhive change affects is not known. A readable document
   * already has its records and a subscription, and keys for its pending
   * records are tried locally, so it is left to the backup sync.
   */
  #resyncLoading(): void {
    for (const session of this.#sessions) {
      if (!session.ready) this.#resync(session.id)
    }
  }

  /**
   * Run a sedimentree sync round for each open document. A server refuses a
   * round, including the upload of this replica's writes, until the keyhive
   * state that authorizes it has arrived, and nothing else starts another
   * round afterwards. A peer reporting it ingested this replica's keyhive
   * events is the sign that the state has arrived.
   */
  #resyncSessions(): void {
    for (const { id } of this.#sessions) this.#resync(id)
  }

  #resync(id: SedimentreeId): void {
    if (this.#closed) return
    this.#resyncs.run(id)
  }

  async #retrySessions(): Promise<void> {
    await Promise.all(
      [...this.#sessions].map(session =>
        session
          .retry()
          .catch(error => log.error("[KeyhiveBackend] retry failed:", error))
      )
    )
  }
}

function changeId(commit: CommitId): ChangeId {
  return new ChangeId(idBytes(commit))
}

/** Keyhive refused to encrypt a record, e.g., because this replica has no
 * access yet. */
class CannotEncryptYet extends Error {
  constructor(cause: unknown) {
    super("keyhive cannot encrypt this record yet", { cause })
  }
}

/** A store waiting for its records to be encrypted. */
interface WaitingStore {
  readonly records: readonly SedimentreeRecord[]
  /** Each record encrypted so far. `undefined` for a fragment already stored. */
  readonly encrypted: (
    | { record: SedimentreeRecord; ref: ContentRef }
    | undefined
  )[]
  /** Whether an earlier attempt could not encrypt every record. */
  waited: boolean
  resolve(): void
  reject(error: unknown): void
}
