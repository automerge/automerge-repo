import * as N from "@automerge/subduction/slim"
import {
  BackendError,
  backendId,
  checkpointId,
  commitId,
  copyRecord,
  fragmentRequests,
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
/** Coverage metadata for a scanned item, without retaining its blob. */
function coverageItem(
  item: Extract<N.StoredUpdate, { type: "commit" | "fragment" }>
): CoverageItem {
  if (item.type === "commit")
    return { kind: "commit", id: commitId(item.metadata.head) }
  return {
    kind: "fragment",
    head: commitId(item.metadata.head),
    checkpoints: item.metadata.checkpoints.map(checkpointId),
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
  private readonly engine: N.Subduction
  private closed = false
  private closing?: Promise<void>
  private sequence = 0
  private round = 0
  private readonly deleting = new Map<SedimentreeId, Promise<void>>()
  /**
   * Open sessions per tree. Close and deletion end a tree's sessions in the
   * same turn that raises their barrier, so no session survives either, and
   * fan-outs need no barrier checks of their own.
   */
  private readonly sessions = new Map<SedimentreeId, Set<SessionState>>()
  /** Ephemeral topics last requested from native. */
  private readonly interests = new Set<SedimentreeId>()
  /**
   * Interim stand-in for native per-tree ordering and flush: the latest store's
   * or deletion's acknowledgement per document. Each store resolves only after
   * earlier ones (rejecting if any did); deletions wait for earlier stores;
   * flush and close wait on it. Self-clearing; no failures are retained.
   * Remove once Subduction orders a tree's stores and removals and exposes a
   * flush barrier.
   */
  private readonly acks = new Map<SedimentreeId, Promise<void>>()
  private readonly signer: NativeSigner
  private readonly mintDocumentId?: MintDocumentId
  private readonly network: readonly SubductionNetworkAdapterInterface[]
  /** Every adapter's first attempt has settled, or the backend has closed. */
  private readonly networkSettled: Promise<void>
  private markClosed!: () => void

  constructor(options: SubductionBackendOptions) {
    if (!options.storage) throw new TypeError("A storage adapter is required")
    this.signer = options.signer ?? N.createMemorySigner()
    this.mintDocumentId = options.mintDocumentId
    this.engine = new N.Subduction({
      signer: this.signer,
      storage: new StorageBridge(options.storage),
      defaultTimeoutMilliseconds: options.syncTimeoutMilliseconds,
      onEphemeral: (topic: N.Topic, peer: N.PeerId, bytes: Uint8Array) =>
        this.onEphemeral(topic, peer, bytes),
      onRemoteHeads: (
        id: N.SedimentreeId,
        peer: N.PeerId,
        heads: N.CommitId[]
      ) => this.onRemoteHeads(id, peer, heads),
    })
    this.network = [...new Set(options.network ?? [])]
    const connect: SubductionConnect = (transport, audience) =>
      this.addConnection(transport, audience)
    const closed = new Promise<void>(resolve => {
      this.markClosed = resolve
    })
    // A failed first attempt is settled too: waiting longer cannot tell a
    // document lookup anything more until that adapter reconnects.
    const started = Promise.allSettled(
      this.network.map(adapter => {
        try {
          return adapter.start(connect)
        } catch (cause) {
          return Promise.reject(cause)
        }
      })
    )
    this.networkSettled = Promise.race([started.then(() => {}), closed])
  }
  /** Hex-encoded verifying key of this backend's signer. */
  get peerId(): string {
    return Array.from(this.signer.verifyingKey(), b =>
      b.toString(16).padStart(2, "0")
    ).join("")
  }
  private onEphemeral(topic: N.Topic, peer: N.PeerId, bytes: Uint8Array) {
    const tree = topic as SedimentreeId
    const active = [...this.sessionsFor(tree)].filter(s => s.watch.active)
    if (!active.length) return
    const message = decodeEphemeral(bytes)
    if (!message) return
    const sequence = ++this.sequence
    const sender = this.peerIdentity(peer)
    // Metadata is frozen and shared; each session owns its payload bytes.
    for (const { watch } of active)
      watch.push({
        type: "ephemeral",
        sequence,
        message: { ...message, payload: new Uint8Array(message.payload) },
        sender,
      })
  }
  private onRemoteHeads(
    id: N.SedimentreeId,
    peer: N.PeerId,
    heads: N.CommitId[]
  ) {
    const tree = id as SedimentreeId
    if (!this.sessions.has(tree)) return
    // Shared by every session on the tree.
    this.broadcast(
      tree,
      Object.freeze({
        type: "remote-heads",
        sequence: ++this.sequence,
        remote: this.peerIdentity(peer),
        heads: Object.freeze(heads.map(commitId)),
      })
    )
  }
  private sessionsFor(id: SedimentreeId): Iterable<SessionState> {
    return this.sessions.get(id) ?? []
  }
  private broadcast(id: SedimentreeId, event: SedimentreeEvent): void {
    for (const { watch } of this.sessionsFor(id)) watch.push(event)
  }
  private failure(
    operation: BackendOperation,
    cause: unknown,
    terminal = false
  ): Extract<SedimentreeEvent, { type: "failure" }> {
    return {
      type: "failure",
      sequence: ++this.sequence,
      error: error(operation, cause, terminal),
    }
  }
  private peerIdentity(peer: N.PeerId): BackendIdentity {
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
    this.check("synchronize")
    try {
      return await this.engine.connectTransport(transport, audience)
    } catch (cause) {
      throw error("synchronize", cause)
    }
  }
  /** Accepting side of addConnection. */
  async acceptConnection(
    transport: Transport,
    audience: TransportAudience
  ): Promise<string> {
    this.check("synchronize")
    try {
      return await this.engine.acceptTransport(transport, audience)
    } catch (cause) {
      throw error("synchronize", cause)
    }
  }
  private reconcileInterest(id: SedimentreeId): void {
    if (this.closed) return
    const desired = [...this.sessionsFor(id)].some(s => s.watch.active)
    if (desired === this.interests.has(id)) return
    if (desired) this.interests.add(id)
    else this.interests.delete(id)
    // Native never reports control-send failures; only a closing engine rejects.
    void (
      desired
        ? this.engine.subscribeEphemeral([id])
        : this.engine.unsubscribeEphemeral([id])
    ).catch(() => {})
  }
  /**
   * One confirmation round for an incomplete session whose local load was empty,
   * at most one in flight. Its marker covers everything each peer had.
   */
  private confirm(session: SessionState): void {
    if (session.confirming || session.completed) return
    session.confirming = true
    void this.syncRound(session.id, session)
      .catch(cause => session.watch.push(this.failure("synchronize", cause)))
      .finally(() => {
        session.confirming = false
      })
  }
  /** Propagate a stored batch without an open session; one round per batch. */
  private scheduleSync(id: SedimentreeId): void {
    void this.syncRound(id).catch(cause =>
      this.broadcast(id, this.failure("synchronize", cause))
    )
  }
  private async syncRound(
    id: SedimentreeId,
    recipient?: SessionState
  ): Promise<SyncRoundResult> {
    this.check("synchronize", id)
    const engine = this.engine
    const roundId = `subduction-${++this.round}`
    // Native hydrates the tree before checking for peers, so skip it when none
    // is connected. Remove once syncWithAllPeers short-circuits itself.
    // Peer failures are reported per peer; a rejection is local (storage or
    // closed) and rejects the round.
    const results = (await engine.getConnectedPeerIds()).length
      ? Object.entries(await engine.syncWithAllPeers(id, { subscribe: true }))
      : []
    // Store-triggered rounds only propagate; with no peers there is nothing
    // to report. Explicit rounds always answer their session.
    if (!results.length && !recipient)
      return {
        roundId,
        marker: { sequence: ++this.sequence, heads: [] },
        outcome: "no-peers",
        peers: [],
      }
    this.check("synchronize", id)
    // Native updates its tree before the round resolves, so these heads
    // include whatever the round ingested.
    const marker = await this.headsMarker(id)
    const outcomes: SyncRoundResult["peers"][number][] = results.map(
      ([peer, response]) => {
        const failures = response.transportErrors
        return {
          peer: this.peerIdentity(peer),
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
    // Shared by the caller and every session on the tree.
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
    if (recipient) recipient.watch.push({ type: "synchronized", result })
    else this.broadcast(id, { type: "synchronized", result })
    return result
  }
  private check(operation: BackendOperation, id?: SedimentreeId): void {
    if (this.closed)
      throw new BackendError(operation, "closed", "Backend is closed")
    if (id && this.deleting.has(id))
      throw new BackendError(operation, "deleted", "Deletion barrier is active")
  }
  /** Stream items follow native's cache update, so native heads include them. */
  private async liveMarker(session: SessionState): Promise<void> {
    // Markers only establish readiness; completed sessions no longer need them.
    if (session.completed) return
    const target = await this.headsMarker(session.id)
    session.watch.push({ type: "history-marker", marker: target })
  }
  private async headsMarker(native: N.SedimentreeId): Promise<HistoryMarker> {
    const heads = (await this.engine.getHeads(native)) ?? []
    return { sequence: ++this.sequence, heads: heads.map(commitId).sort() }
  }
  private release(session: SessionState): void {
    session.released = true
    session.stream?.close()
    const open = this.sessions.get(session.id)
    open?.delete(session)
    if (!open?.size) this.sessions.delete(session.id)
    this.reconcileInterest(session.id)
  }
  /** One native stream per session keeps syncing across connections. */
  private async observe(session: SessionState): Promise<void> {
    const { id, watch } = session
    this.check("open", id)
    if (session.released) return
    const updates = this.engine.loadAndWatch(id)
    session.stream = updates
    // Storage-scan items pass on as blobs, each as it arrives; every scan
    // ends with local-load-complete. Peer and local updates flow as records.
    // Each scan, and each live record, requests fragments for the boundary
    // commits it leaves uncovered.
    let initialized = false
    let scanning = true
    let found = false
    let scanned: CoverageItem[] = []
    const requests = (items: readonly CoverageItem[]) => {
      const heads = fragmentRequests(
        items,
        head => this.engine.commitDepth(head) > 0
      )
      return heads.length
        ? [
            {
              type: "fragments-requested",
              sequence: ++this.sequence,
              heads,
            } as const,
          ]
        : []
    }
    try {
      for await (const update of updates) {
        if (session.released) break
        if (update.type === "commit" || update.type === "fragment") {
          if (scanning) {
            found = true
            scanned.push(coverageItem(update))
            const event: SedimentreeEvent = {
              type: "blobs",
              sequence: ++this.sequence,
              blobs: [update.blob],
            }
            if (initialized) watch.push(event)
            else watch.pushInitial(event)
            continue
          }
          const record = storedRecord(update)
          watch.push({
            type: "records",
            sequence: ++this.sequence,
            phase: "live",
            records: [record],
          })
          for (const event of requests([record])) watch.push(event)
          // Data a peer sends back in its own round arrives as unordered
          // fire-and-forget records with no completion event; heads read
          // between them can name a complete prefix. Without local history,
          // confirm with a round of our own, as Subduction's design advises.
          if (found) await this.liveMarker(session)
          else this.confirm(session)
        } else if (update.type === "storageChecked") {
          if (!scanning) continue
          scanning = false
          const complete = {
            type: "local-load-complete",
            found,
            backendSyncs: true,
          } as const
          const requested = requests(scanned)
          scanned = []
          if (initialized) {
            watch.push(complete)
            for (const event of requested) watch.push(event)
            continue
          }
          initialized = true
          // Peers still connecting may have the document.
          if (!found) await this.networkSettled
          if (session.released) break
          watch.initialize([complete, ...requested])
          this.reconcileInterest(id)
          // loadAndWatch reports neither failed rounds nor an empty settled
          // load, so one explicit round decides whether connected peers
          // have this document (none connected: "no-peers"). Remove once
          // native reports it.
          if (!found) this.confirm(session)
        } else if (update.type === "peerSynced") {
          // Ordered after the round's items, so native heads include them.
          await this.liveMarker(session)
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
    this.check("open")
    const id = backendId("open", input)
    this.check("open", id)
    const session: SessionState = {
      id,
      watch: new Watch<SedimentreeEvent>(() => this.release(session)),
      released: false,
      completed: false,
      confirming: false,
    }
    const { watch } = session
    const open = this.sessions.get(id)
    if (open) open.add(session)
    else this.sessions.set(id, new Set([session]))
    void this.observe(session).catch(cause =>
      watch.finish(this.failure("open", cause, true))
    )
    const sessionCheck = (op: BackendOperation) => {
      this.check(op, id)
      if (session.released)
        throw new BackendError(op, "closed", "Session is closed")
    }
    return {
      events: watch,
      synchronize: (options = {}) => {
        try {
          sessionCheck("synchronize")
          const work = this.syncRound(id, session).catch(cause => {
            const failure = this.failure("synchronize", cause)
            watch.push(failure)
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
          await this.engine.publishEphemeral(id, bytes)
        } catch (cause) {
          throw error("ephemeral", cause)
        }
      },
      markComplete: () => {
        session.completed = true
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
    this.check("create")
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
    const id =
      options.documentId !== undefined
        ? backendId("create", options.documentId)
        : await mintBackendId(records, this.mintDocumentId)
    await this.storeRecords(id, records, true)
    return id
  }
  store(input: SedimentreeId, batch: RecordBatch): Promise<void> {
    return this.storeRecords(input, batch)
  }
  private storeRecords(
    input: SedimentreeId,
    records: RecordBatch,
    creating = false
  ): Promise<void> {
    try {
      const id = backendId(creating ? "create" : "store", input)
      this.check("store", id)
      const operation = creating ? "create" : "store"
      const engine = this.engine
      const write = (async () => {
        let submitted = false
        try {
          if (creating) {
            const heads = (await engine.getHeads(id)) ?? []
            if (heads.length)
              throw new BackendError(
                "create",
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
          submitted = !single
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
              // once and minimizes once.
              await engine.storeBatch(id, { commits, fragments })
            }
          } catch (cause) {
            // Native rejects invalid input (including wire count limits)
            // with a TypeError before signing or writing anything.
            if (!(cause instanceof TypeError)) throw cause
            submitted = false
            throw new BackendError(
              operation,
              "invalid-record",
              cause.message,
              false,
              { cause }
            )
          }
        } finally {
          // Durability never waits for a peer; a round propagates batches even
          // without a document session. A failed batch may still have made
          // some records durable; they must propagate too, and a retry of the
          // whole batch dedupes them.
          if (submitted) this.scheduleSync(id)
        }
      })().catch(cause => {
        throw error(operation, cause)
      })
      // Saves run concurrently; acknowledgement follows submission order.
      const earlier = this.acks.get(id)
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
      this.acks.set(id, ack)
      const clear = () => {
        if (this.acks.get(id) === ack) this.acks.delete(id)
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
    this.check("flush")
    const targets = ids?.map(id => backendId("flush", id))
    const captured = targets
      ? targets.flatMap(id => this.acks.get(id) ?? [])
      : [...this.acks.values()]
    const errors = (await Promise.allSettled(captured)).flatMap(r =>
      r.status === "rejected" ? [r.reason] : []
    )
    if (errors.length)
      throw new AggregateError(errors, "Accepted persistence attempts failed")
  }
  deleteLocal(input: SedimentreeId): Promise<void> {
    try {
      this.check("delete")
      const id = backendId("delete", input)
      if (this.deleting.has(id)) return this.deleting.get(id)!
      // Ending the sessions in the same turn as the barrier below is what lets
      // fan-outs skip deletion checks.
      const sequence = ++this.sequence
      for (const { watch } of this.sessionsFor(id))
        watch.finish({ type: "deleted", sequence })
      // Local stores accepted earlier land first, and flush covers the
      // removal. Native owns removal and should fence ingested writes and
      // peer sync for this tree.
      const earlier = this.acks.get(id)
      const work: Promise<void> = (async () => {
        await Promise.allSettled([earlier])
        await this.engine.removeSedimentree(id)
      })()
        .catch(cause => {
          throw error("delete", cause)
        })
        .finally(() => {
          if (this.acks.get(id) === work) this.acks.delete(id)
          this.deleting.delete(id)
        })
      this.acks.set(id, work)
      this.deleting.set(id, work)
      return work
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    // Disconnect at once so stalled peer waits end. Native close would cancel
    // accepted local stores and deletions, so let them settle first; their
    // failures belong to flush, not close. Native close drains its own tasks.
    const accepted = [...this.acks.values()]
    const disconnected = this.engine.disconnectAll()
    // Deferred so adapters that re-enter close() see the installed guard.
    const adapters = this.network.map(adapter =>
      Promise.resolve().then(() => adapter.stop())
    )
    this.closing = (async () => {
      const [disconnect, ...rest] = await Promise.allSettled([
        disconnected,
        ...adapters,
        ...accepted,
      ])
      const closed = await Promise.allSettled([this.engine.close()])
      this.engine.free()
      const errors = [
        disconnect,
        ...rest.slice(0, adapters.length),
        closed[0],
      ].flatMap(r => (r.status === "rejected" ? [r.reason] : []))
      if (errors.length)
        throw new AggregateError(errors, "Backend close failed")
    })()
    this.markClosed()
    for (const open of this.sessions.values())
      for (const { watch } of open) watch.finish()
    return this.closing
  }
}
