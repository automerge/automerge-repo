import * as N from "@automerge/subduction/slim"
import {
  BackendError,
  backendId,
  checkpointId,
  commitId,
  copyRecord,
  headsOf,
  mintBackendId,
  type BackendIdentity,
  type CoverageItem,
  type MintDocumentId,
  type BackendOperation,
  type HistoryMarker,
  type SedimentreeRecord,
  type FragmentRecord,
  type LooseCommitRecord,
  type RecordBatch,
  type SedimentreeBackend,
  type SedimentreeEvent,
  type SedimentreeId,
  type SedimentreeSession,
  type SyncRoundResult,
} from "@automerge/automerge-repo/sedimentree"
import { StorageBridge } from "./storage.js"
import type { SubductionStorageAdapterInterface } from "./storage/SubductionStorageAdapterInterface.js"
import type {
  SubductionConnect,
  SubductionNetworkAdapterInterface,
} from "./network/SubductionNetworkAdapterInterface.js"
import { Watch } from "./watch.js"
import type { SessionState } from "./session.js"
import { decodeEphemeral, encodeEphemeral } from "./ephemeral.js"

export type { SubductionStorageAdapterInterface } from "./storage/SubductionStorageAdapterInterface.js"
export type {
  SubductionConnect,
  SubductionNetworkAdapterInterface,
} from "./network/SubductionNetworkAdapterInterface.js"
/** Keep alive through backend.close(). Requires a valid Ed25519 verifying
 * key and matching signatures; native does not validate providers safely.
 */
export type NativeSigner = N.Signer
/** Framed byte transport; the backend authenticates it with its signer. */
export type Transport = N.Transport
export type TransportAudience = N.TransportAudience

export interface SubductionBackendOptions {
  /** Defaults to a new in-memory identity, which does not survive restart. */
  signer?: NativeSigner
  storage: SubductionStorageAdapterInterface
  /** Started at construction and stopped by close(). */
  network?: readonly SubductionNetworkAdapterInterface[]
  /** Native default request deadline (Subduction's own default when unset;
   * validated by Subduction). Not a deadline on local storage or handshake. */
  syncTimeoutMilliseconds?: number
  /**
   * Mints the 32-byte ID for `create()` without a supplied ID; defaults to
   * {@link mintDocumentId}. On a keyhive-enabled server, a minted ID must be
   * the verifying key of a keyhive document that server knows (e.g. from
   * keyhive's `generate_doc`, given the initial heads).
   */
  mintDocumentId?: MintDocumentId
}

function error(
  operation: BackendOperation,
  cause: unknown,
  terminal = false
): BackendError {
  if (cause instanceof Error && cause.name === "SubductionClosedError")
    return new BackendError(operation, "closed", cause.message, false, {
      cause,
    })
  if (cause instanceof BackendError)
    return new BackendError(
      operation,
      cause.code,
      cause.message,
      !terminal && cause.retryable,
      { cause }
    )
  return new BackendError(operation, "io", String(cause), !terminal, { cause })
}
/** Record for an item on a native stored stream. */
function storedRecord(
  item: Extract<N.StoredUpdate, { type: "commit" | "fragment" }>
): SedimentreeRecord {
  if (item.type === "commit")
    return {
      kind: "commit",
      id: commitId(item.metadata.head),
      parents: item.metadata.parents.map(commitId),
      blob: item.blob,
    }
  return {
    kind: "fragment",
    head: commitId(item.metadata.head),
    boundary: item.metadata.boundary.map(commitId),
    checkpoints: item.metadata.checkpoints.map(checkpointId),
    blob: item.blob,
  }
}
/** Coverage metadata of a scanned record, without retaining its blob. */
function coverageItem(record: SedimentreeRecord): CoverageItem {
  if (record.kind === "commit")
    return { kind: "commit", id: record.id, parents: record.parents }
  return {
    kind: "fragment",
    head: record.head,
    checkpoints: record.checkpoints,
  }
}
function commitInput(record: LooseCommitRecord): N.CommitInput {
  return { head: record.id, parents: record.parents, blob: record.blob }
}
function fragmentInput(record: FragmentRecord): N.FragmentInput {
  return {
    head: record.head,
    boundary: record.boundary,
    checkpoints: record.checkpoints,
    blob: record.blob,
  }
}
/** Settle every promise; resolve to the reasons of those that rejected. */
async function failures(promises: readonly unknown[]): Promise<unknown[]> {
  return (await Promise.allSettled(promises)).flatMap(r =>
    r.status === "rejected" ? [r.reason] : []
  )
}
function waitOnly<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new Error("Synchronization wait aborted"))
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}

/** EXPERIMENTAL: real WASM persistence and authenticated peer sync.
 * Initialize Subduction WASM before construction. Storage is exclusively owned.
 */
export class SubductionBackend implements SedimentreeBackend {
  readonly #engine: N.Subduction
  #closed = false
  #closing?: Promise<void>
  #sequence = 0
  #round = 0
  readonly #deleting = new Map<SedimentreeId, Promise<void>>()
  /**
   * Open sessions per tree. Close and deletion end a tree's sessions in the
   * same turn that raises their barrier, so no session survives either, and
   * fan-outs need no barrier checks of their own.
   */
  readonly #sessions = new Map<SedimentreeId, Set<SessionState>>()
  /** Ephemeral topics last requested from native. */
  readonly #interests = new Set<SedimentreeId>()
  /**
   * Interim stand-in for native per-tree ordering and flush: the latest store's
   * or deletion's acknowledgement per document. Each store resolves only after
   * earlier ones (rejecting if any did); deletions wait for earlier stores;
   * flush and close wait on it. Self-clearing; no failures are retained.
   * Remove once Subduction orders a tree's stores and removals and exposes a
   * flush barrier.
   */
  readonly #acks = new Map<SedimentreeId, Promise<void>>()
  readonly #signer: NativeSigner
  readonly #mintDocumentId?: MintDocumentId
  readonly #network: readonly SubductionNetworkAdapterInterface[]
  /** Every adapter's first attempt has settled, or the backend has closed. */
  readonly #networkSettled: Promise<void>
  #markClosed!: () => void

  constructor(options: SubductionBackendOptions) {
    if (!options.storage) throw new TypeError("A storage adapter is required")
    this.#signer = options.signer ?? N.createMemorySigner()
    this.#mintDocumentId = options.mintDocumentId
    this.#engine = new N.Subduction({
      signer: this.#signer,
      storage: new StorageBridge(options.storage),
      defaultTimeoutMilliseconds: options.syncTimeoutMilliseconds,
      onEphemeral: (topic: N.Topic, peer: N.PeerId, bytes: Uint8Array) =>
        this.#onEphemeral(topic, peer, bytes),
      onRemoteHeads: (
        id: N.SedimentreeId,
        peer: N.PeerId,
        heads: N.CommitId[]
      ) => this.#onRemoteHeads(id, peer, heads),
    })
    this.#network = [...new Set(options.network ?? [])]
    const connect: SubductionConnect = (transport, audience) =>
      this.addConnection(transport, audience)
    const closed = new Promise<void>(resolve => {
      this.#markClosed = resolve
    })
    // A failed first attempt is settled too: waiting longer cannot tell a
    // document lookup anything more until that adapter reconnects.
    const started = Promise.allSettled(
      this.#network.map(adapter => {
        try {
          return adapter.start(connect)
        } catch (cause) {
          return Promise.reject(cause)
        }
      })
    )
    this.#networkSettled = Promise.race([started.then(() => {}), closed])
  }
  /** Hex-encoded verifying key of this backend's signer. */
  get peerId(): string {
    return Array.from(this.#signer.verifyingKey(), b =>
      b.toString(16).padStart(2, "0")
    ).join("")
  }
  #onEphemeral(topic: N.Topic, peer: N.PeerId, bytes: Uint8Array) {
    const tree = topic as SedimentreeId
    const active = [...this.#sessionsFor(tree)].filter(s => s.watch.active)
    if (!active.length) return
    const message = decodeEphemeral(bytes)
    if (!message) return
    const sequence = ++this.#sequence
    const sender = this.#peerIdentity(peer)
    // Metadata is frozen and shared; each session owns its payload bytes.
    for (const { watch } of active)
      watch.push({
        type: "ephemeral",
        sequence,
        message: { ...message, payload: new Uint8Array(message.payload) },
        sender,
      })
  }
  #onRemoteHeads(id: N.SedimentreeId, peer: N.PeerId, heads: N.CommitId[]) {
    const tree = id as SedimentreeId
    if (!this.#sessions.has(tree)) return
    // Shared by every session on the tree.
    this.#broadcast(
      tree,
      Object.freeze({
        type: "remote-heads",
        sequence: ++this.#sequence,
        remote: this.#peerIdentity(peer),
        heads: Object.freeze(heads.map(commitId)),
      })
    )
  }
  #sessionsFor(id: SedimentreeId): Iterable<SessionState> {
    return this.#sessions.get(id) ?? []
  }
  #broadcast(id: SedimentreeId, event: SedimentreeEvent): void {
    for (const { watch } of this.#sessionsFor(id)) this.#deliver(watch, event)
  }
  /** A nonretryable failure ends the watch; everything else queues. */
  #deliver(watch: Watch<SedimentreeEvent>, event: SedimentreeEvent): void {
    if (event.type === "failure" && !event.error.retryable) watch.finish(event)
    else watch.push(event)
  }
  #failure(
    operation: BackendOperation,
    cause: unknown,
    terminal = false
  ): Extract<SedimentreeEvent, { type: "failure" }> {
    return {
      type: "failure",
      sequence: ++this.#sequence,
      error: error(operation, cause, terminal),
    }
  }
  #peerIdentity(peer: N.PeerId): BackendIdentity {
    return Object.freeze({
      kind: "subduction",
      id: peer,
      path: Object.freeze([]),
    })
  }
  /** Authenticate an outgoing transport with this backend's signer and add
   * the connection; resolves to the remote peer ID. The engine disconnects it
   * on close. Keep the JS transport alive until disconnection.
   *
   * Open streams sync the new connection themselves, and native serves peer
   * requests for any stored tree, so stored-but-unopened documents are not
   * replayed here (matching Repo's historical connect behaviour).
   */
  async addConnection(
    transport: Transport,
    audience: TransportAudience
  ): Promise<string> {
    this.#check("synchronize")
    try {
      return await this.#engine.connectTransport(transport, audience)
    } catch (cause) {
      throw error("synchronize", cause)
    }
  }
  /** Accepting side of addConnection. */
  async acceptConnection(
    transport: Transport,
    audience: TransportAudience
  ): Promise<string> {
    this.#check("synchronize")
    try {
      return await this.#engine.acceptTransport(transport, audience)
    } catch (cause) {
      throw error("synchronize", cause)
    }
  }
  #reconcileInterest(id: SedimentreeId): void {
    if (this.#closed) return
    const desired = [...this.#sessionsFor(id)].some(s => s.watch.active)
    if (desired === this.#interests.has(id)) return
    if (desired) this.#interests.add(id)
    else this.#interests.delete(id)
    // Native never reports control-send failures; only a closing engine rejects.
    void (
      desired
        ? this.#engine.subscribeEphemeral([id])
        : this.#engine.unsubscribeEphemeral([id])
    ).catch(() => {})
  }
  /**
   * One confirmation round for a session not yet ready whose local load was empty,
   * at most one in flight. Its marker covers everything each peer had.
   */
  #confirm(session: SessionState): void {
    if (session.confirming || session.ready) return
    session.confirming = true
    void this.#syncRound(session.id, session)
      .catch(cause =>
        this.#deliver(session.watch, this.#failure("synchronize", cause))
      )
      .finally(() => {
        session.confirming = false
      })
  }
  /**
   * Send a stored batch to peers, with or without an open session; one round
   * per batch. Nothing awaits or reads its result; local failures are reported
   * to the tree's sessions.
   */
  #propagate(id: SedimentreeId): void {
    void (async () => {
      this.#check("synchronize", id)
      await this.#syncAllPeers(id)
    })().catch(cause =>
      this.#broadcast(id, this.#failure("synchronize", cause))
    )
  }
  /**
   * Per-peer results; a rejection is local (storage or closed). Native hydrates
   * the tree before checking for peers, so skip it when none is connected.
   * Remove the check once syncWithAllPeers short-circuits itself.
   */
  async #syncAllPeers(
    id: SedimentreeId
  ): Promise<[N.PeerId, N.PeerSyncResult][]> {
    if (!(await this.#engine.getConnectedPeerIds()).length) return []
    return Object.entries(
      await this.#engine.syncWithAllPeers(id, { subscribe: true })
    )
  }
  /** A round answering one session: its result is pushed there and returned. */
  async #syncRound(
    id: SedimentreeId,
    recipient: SessionState
  ): Promise<SyncRoundResult> {
    this.#check("synchronize", id)
    const roundId = `subduction-${++this.#round}`
    const results = await this.#syncAllPeers(id)
    this.#check("synchronize", id)
    // Native updates its tree before the round resolves, so these heads
    // include whatever the round ingested.
    const marker = await this.#headsMarker(id)
    const outcomes: SyncRoundResult["peers"][number][] = results.map(
      ([peer, response]) => {
        const failures = response.transportErrors
        return {
          peer: this.#peerIdentity(peer),
          // A successful round that leaves the tree empty: the peer lacks it.
          outcome: !response.success
            ? "failed"
            : marker.heads.length
              ? "complete"
              : "unavailable",
          ...(failures.length
            ? {
                error: error(
                  "synchronize",
                  new AggregateError(failures, "Peer synchronization failed")
                ),
              }
            : !response.success
              ? {
                  error: new BackendError(
                    "synchronize",
                    "unsupported",
                    "Native sync does not distinguish absent, unauthorized, and disconnected peers"
                  ),
                }
              : {}),
        }
      }
    )
    // Shared by the caller and its session's event.
    const result: SyncRoundResult = Object.freeze({
      roundId,
      marker: Object.freeze({ ...marker, heads: Object.freeze(marker.heads) }),
      outcome: !outcomes.length
        ? "no-peers"
        : outcomes.some(p => p.outcome === "failed")
          ? "failed"
          : "complete",
      peers: Object.freeze(outcomes.map(p => Object.freeze(p))),
    })
    recipient.watch.push({ type: "synchronized", result })
    return result
  }
  #check(operation: BackendOperation, id?: SedimentreeId): void {
    if (this.#closed)
      throw new BackendError(operation, "closed", "Backend is closed")
    if (id && this.#deleting.has(id))
      throw new BackendError(operation, "deleted", "Deletion barrier is active")
  }
  /** Stream items follow native's cache update, so native heads include them. */
  async #liveMarker(session: SessionState): Promise<void> {
    // Markers only establish readiness; ready sessions no longer need them.
    if (session.ready) return
    const target = await this.#headsMarker(session.id)
    session.watch.push({ type: "history-marker", marker: target })
  }
  async #headsMarker(native: N.SedimentreeId): Promise<HistoryMarker> {
    const heads = (await this.#engine.getHeads(native)) ?? []
    return { sequence: ++this.#sequence, heads: heads.map(commitId).sort() }
  }
  #release(session: SessionState): void {
    session.released = true
    session.stream?.close()
    const open = this.#sessions.get(session.id)
    open?.delete(session)
    if (!open?.size) this.#sessions.delete(session.id)
    this.#reconcileInterest(session.id)
  }
  /** One native stream per session keeps syncing across connections. */
  async #observe(session: SessionState): Promise<void> {
    const { id, watch } = session
    this.#check("open", id)
    if (session.released) return
    const updates = this.#engine.loadAndWatch(id)
    session.stream = updates
    // The first storage scan passes on as initial records, each as it
    // arrives, ending with local-load-complete and the scanned heads. Rescan,
    // peer and local items flow as live records.
    let initialized = false
    let scanning = true
    let found = false
    let scanned: CoverageItem[] = []
    try {
      for await (const update of updates) {
        if (session.released) break
        if (update.type === "commit" || update.type === "fragment") {
          const record = storedRecord(update)
          if (scanning) {
            found = true
            const event: SedimentreeEvent = {
              type: "records",
              sequence: ++this.#sequence,
              phase: initialized ? "live" : "initial",
              records: [record],
            }
            if (initialized) watch.push(event)
            else {
              scanned.push(coverageItem(record))
              watch.pushInitial(event)
            }
            continue
          }
          watch.push({
            type: "records",
            sequence: ++this.#sequence,
            phase: "live",
            records: [record],
          })
          // Data a peer sends back in its own round arrives as unordered
          // fire-and-forget records with no completion event; heads read
          // between them can name a complete prefix. Without local history,
          // confirm with a round of our own, as Subduction's design advises.
          if (found) await this.#liveMarker(session)
          else this.#confirm(session)
        } else if (update.type === "storageChecked") {
          if (!scanning) continue
          scanning = false
          if (initialized) continue
          initialized = true
          const complete = {
            type: "local-load-complete",
            marker: { sequence: ++this.#sequence, heads: headsOf(scanned) },
            found,
          } as const
          scanned = []
          // Peers still connecting may have the document.
          if (!found) await this.#networkSettled
          if (session.released) break
          watch.initialize([complete])
          this.#reconcileInterest(id)
          // loadAndWatch reports neither failed rounds nor an empty settled
          // load, so one explicit round decides whether connected peers
          // have this document (none connected: "no-peers"). Remove once
          // native reports it.
          if (!found) this.#confirm(session)
        } else if (update.type === "peerSynced") {
          // Ordered after the round's items, so native heads include them.
          await this.#liveMarker(session)
        } else if (update.type === "rescanRequired") {
          scanning = true
          found = false
          scanned = []
        }
      }
    } catch (cause) {
      if (!session.released) throw cause
    } finally {
      updates.close()
    }
  }
  open(input: SedimentreeId): SedimentreeSession {
    this.#check("open")
    const id = backendId("open", input)
    this.#check("open", id)
    const session: SessionState = {
      id,
      watch: new Watch<SedimentreeEvent>(() => this.#release(session)),
      released: false,
      ready: false,
      confirming: false,
    }
    const { watch } = session
    const open = this.#sessions.get(id)
    if (open) open.add(session)
    else this.#sessions.set(id, new Set([session]))
    void this.#observe(session).catch(cause =>
      watch.finish(this.#failure("open", cause, true))
    )
    const sessionCheck = (op: BackendOperation) => {
      this.#check(op, id)
      if (session.released)
        throw new BackendError(op, "closed", "Session is closed")
    }
    return {
      events: watch,
      synchronize: (options = {}) => {
        try {
          sessionCheck("synchronize")
          const work = this.#syncRound(id, session).catch(cause => {
            const failure = this.#failure("synchronize", cause)
            this.#deliver(watch, failure)
            throw failure.error
          })
          // An aborted wait leaves the round's own rejection unobserved.
          void work.catch(() => {})
          return waitOnly(work, options.signal)
        } catch (cause) {
          return Promise.reject(cause)
        }
      },
      publishEphemeral: async message => {
        sessionCheck("ephemeral")
        const bytes = encodeEphemeral(message)
        try {
          await this.#engine.publishEphemeral(id, bytes)
        } catch (cause) {
          throw error("ephemeral", cause)
        }
      },
      markReady: () => {
        session.ready = true
      },
      close: async () => {
        await watch.return()
      },
    }
  }
  async create(
    initialRecords: RecordBatch,
    options: { documentId?: SedimentreeId } = {}
  ): Promise<SedimentreeId> {
    this.#check("create")
    if (!initialRecords.length)
      throw new BackendError(
        "create",
        "invalid-record",
        "Initial history is empty"
      )
    // Native snapshots input only once storeBatch is called; minting and the
    // existence check await first, so snapshot here.
    let records: SedimentreeRecord[]
    try {
      records = initialRecords.map(copyRecord)
    } catch (cause) {
      throw new BackendError("create", "invalid-record", String(cause), false, {
        cause,
      })
    }
    const { documentId } = options
    const id =
      documentId !== undefined
        ? backendId("create", documentId)
        : await mintBackendId(records, this.#mintDocumentId)
    // Only a supplied or custom-minted ID can already exist; the default
    // minter's random IDs cannot, so they skip the existence read.
    const checkExisting = documentId !== undefined || !!this.#mintDocumentId
    await this.#storeRecords(id, records, true, checkExisting)
    return id
  }
  store(input: SedimentreeId, batch: RecordBatch): Promise<void> {
    return this.#storeRecords(input, batch)
  }
  #storeRecords(
    input: SedimentreeId,
    records: RecordBatch,
    creating = false,
    checkExisting = false
  ): Promise<void> {
    try {
      const id = backendId(creating ? "create" : "store", input)
      this.#check("store", id)
      const operation = creating ? "create" : "store"
      const engine = this.#engine
      const write = (async () => {
        // Best effort: concurrent creates of one ID are not fenced.
        if (checkExisting) {
          const heads = (await engine.getHeads(id)) ?? []
          if (heads.length)
            throw new BackendError(
              operation,
              "conflict",
              "Document already exists"
            )
        }
        // A single record to an existing tree is pushed to subscribed peers
        // (both directions of a subscribing round) and needs no round.
        // Batches (imports, merges) and new trees are stored in one native
        // call; a round then sends peers only what they lack, and a new
        // tree reaches peers through its session's first round.
        const single = !creating && records.length === 1 ? records[0] : null
        try {
          // Native validates and copies its input synchronously here, before
          // store() returns, so callers may reuse their buffers at once.
          if (single?.kind === "commit")
            // The returned fragment hint is ignored: Repo owns compaction.
            await engine.addCommit(id, commitInput(single))
          else if (single?.kind === "fragment")
            await engine.addFragment(id, fragmentInput(single))
          else {
            const commits: N.CommitInput[] = []
            const fragments: N.FragmentInput[] = []
            for (const record of records)
              if (record.kind === "commit") commits.push(commitInput(record))
              else fragments.push(fragmentInput(record))
            // One native call signs everything, saves through the bridge
            // once (atomically) and minimizes once.
            await engine.storeBatch(id, { commits, fragments })
          }
        } catch (cause) {
          // Native rejects invalid input (including wire count limits)
          // with a TypeError before signing or writing anything.
          if (!(cause instanceof TypeError)) throw cause
          throw new BackendError(
            operation,
            "invalid-record",
            cause.message,
            false,
            { cause }
          )
        }
        // Durability never waits for a peer; a round propagates batches even
        // without a document session. A failed batch stored nothing to send.
        if (!single) this.#propagate(id)
      })().catch(cause => {
        throw error(operation, cause)
      })
      // Saves run concurrently; acknowledgement follows submission order.
      const earlier = this.#acks.get(id)
      const ack = earlier
        ? Promise.allSettled([earlier, write]).then(([before, own]) => {
            if (own.status === "rejected") throw own.reason
            if (before.status === "rejected")
              throw new BackendError(
                operation,
                "io",
                "An earlier store to this document failed",
                false,
                { cause: before.reason }
              )
          })
        : write
      this.#acks.set(id, ack)
      const clear = () => {
        if (this.#acks.get(id) === ack) this.#acks.delete(id)
      }
      void ack.then(clear, clear)
      return ack
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
  /**
   * Waits for local stores and deletions accepted before the call and reports
   * their failures. Ingested writes are not covered: native has no barrier yet.
   */
  async flush(ids?: readonly SedimentreeId[]): Promise<void> {
    this.#check("flush")
    const targets = ids?.map(id => backendId("flush", id))
    const captured = targets
      ? targets.flatMap(id => this.#acks.get(id) ?? [])
      : [...this.#acks.values()]
    const errors = await failures(captured)
    if (errors.length)
      throw new AggregateError(errors, "Accepted persistence attempts failed")
  }
  deleteLocal(input: SedimentreeId): Promise<void> {
    try {
      this.#check("delete")
      const id = backendId("delete", input)
      if (this.#deleting.has(id)) return this.#deleting.get(id)!
      // Ending the sessions in the same turn as the barrier below is what lets
      // fan-outs skip deletion checks.
      const sequence = ++this.#sequence
      for (const { watch } of this.#sessionsFor(id))
        watch.finish({ type: "deleted", sequence })
      // Local stores accepted earlier land first, and flush covers the
      // removal. Native owns removal and should fence ingested writes and
      // peer sync for this tree.
      const earlier = this.#acks.get(id)
      const work: Promise<void> = (async () => {
        await Promise.allSettled([earlier])
        await this.#engine.removeSedimentree(id)
      })()
        .catch(cause => {
          throw error("delete", cause)
        })
        .finally(() => {
          if (this.#acks.get(id) === work) this.#acks.delete(id)
          this.#deleting.delete(id)
        })
      this.#acks.set(id, work)
      this.#deleting.set(id, work)
      return work
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
  close(): Promise<void> {
    // if we are already closing, return the existing promise
    if (this.#closing) return this.#closing
    this.#closed = true
    // get what we need to check during close
    const accepted = [...this.#acks.values()]
    const disconnected = this.#engine.disconnectAll()
    this.#closing = Promise.resolve().then(async () => {
      const errors = await failures([
        disconnected,
        ...this.#network.map(async adapter => adapter.stop()),
      ])
      // Await pending writes and deletes, but failures are handled in flush
      await failures(accepted)
      errors.push(...(await failures([this.#engine.close()])))
      this.#engine.free()
      if (errors.length)
        throw new AggregateError(errors, "Backend close failed")
    })
    this.#markClosed()
    for (const open of this.#sessions.values())
      for (const { watch } of open) watch.finish()
    return this.#closing
  }
}
