import * as N from "@automerge/subduction/slim"
import {
  BackendError,
  commitId,
  copyRecord,
  recordBytes,
  sedimentreeId,
  type BackendIdentity,
  type BackendOperation,
  type HistoryMarker,
  type SedimentreeRecord,
  type RecordBatch,
  type SedimentreeBackend,
  type SedimentreeEvent,
  type SedimentreeId,
  type SedimentreeSession,
  type SyncRoundResult,
} from "@automerge/automerge-repo/sedimentree"
import {
  StorageBridge,
  nativeId,
  logicalId,
  storedRecord,
  unsigned,
  unsignedFragment,
} from "./storage.js"
import type { ByteStore } from "./ByteStore.js"
import { Watch } from "./watch.js"
import { notifyBackendClosed } from "./backendLifecycle.js"
import {
  copyEphemeral,
  decodeEphemeral,
  encodeEphemeral,
  topicKey,
} from "./ephemeral.js"

export type { ByteStore } from "./ByteStore.js"
export { MemoryByteStore } from "./MemoryByteStore.js"
export { IndexedDBByteStore } from "./IndexedDBByteStore.js"
export { connectSubductionServer } from "./connect.js"
export type {
  SubductionServer,
  SubductionConnection,
  SubductionConnectionStatus,
  SubductionConnectionOptions,
} from "./connect.js"
export { createSubductionPeer } from "./peer.js"
export type { SubductionPeer, SubductionPeerOptions } from "./peer.js"
/** Borrowed: keep alive through backend.close(). Requires a valid Ed25519
 * verifying key and matching signatures; native does not validate providers safely.
 */
export type NativeSigner = N.Signer
/** Authenticate outside the backend; addConnection borrows this wrapper. */
export type AuthenticatedTransport = N.AuthenticatedTransport

export interface SubductionBackendOptions {
  signer: NativeSigner
  storage: ByteStore
  /** Native request deadline, not a deadline on local storage or handshake. */
  syncTimeoutMilliseconds?: number
  replayEvents?: number
  replayBytes?: number
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
function copyEvent(value: SedimentreeEvent): SedimentreeEvent {
  if (value.type === "ephemeral")
    return {
      ...value,
      message: copyEphemeral(value.message),
      sender: { ...value.sender, path: [...value.sender.path] },
    }
  if (value.type === "records" || value.type === "blobs")
    // Each session's native stream yields its own JS copies of stored bytes,
    // and an event is delivered to only that session.
    return value
  if (value.type === "history-marker" || value.type === "local-load-complete")
    return value.marker
      ? {
          ...value,
          marker: { ...value.marker, heads: [...value.marker.heads] },
        }
      : { ...value }
  if (value.type === "synchronized")
    return {
      ...value,
      result: {
        ...value.result,
        marker: {
          ...value.result.marker,
          heads: [...value.result.marker.heads],
        },
        peers: value.result.peers.map(p => ({
          ...p,
          peer: { ...p.peer, path: [...p.peer.path] },
        })),
      },
    }
  if (value.type === "remote-heads")
    return {
      ...value,
      remote: { ...value.remote, path: [...value.remote.path] },
      heads: [...value.heads],
    }
  return { ...value }
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
  private readonly limits: Required<
    Omit<SubductionBackendOptions, "signer" | "storage">
  >
  private readonly bridge: StorageBridge
  private readonly engine: N.Subduction
  private closed = false
  private closing?: Promise<void>
  private sequence = 0
  private round = 0
  private readonly deleting = new Map<SedimentreeId, Promise<void>>()
  private readonly watches = new Map<Watch<SedimentreeEvent>, SedimentreeId>()
  /** One automatic reopen per document until a live update succeeds. */
  private readonly recovering = new Set<SedimentreeId>()
  /** Sessions whose consumer verified a complete snapshot (markComplete). */
  private readonly completed = new Set<Watch<SedimentreeEvent>>()
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

  constructor(options: SubductionBackendOptions) {
    this.signer = options.signer
    this.limits = {
      syncTimeoutMilliseconds: options.syncTimeoutMilliseconds ?? 5000,
      replayEvents: options.replayEvents ?? 128,
      replayBytes: options.replayBytes ?? 4 * 1024 * 1024,
    }
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new TypeError("Limits must be positive safe integers")
    if (this.limits.syncTimeoutMilliseconds > 0xffffffff)
      throw new TypeError("Sync timeout exceeds native u32 range")
    this.bridge = new StorageBridge(options.storage)
    this.engine = this.createEngine()
  }
  private createEngine(): N.Subduction {
    // opts.signer is a JS Signer reference, NOT a consumed WASM pointer.
    return new N.Subduction({
      signer: this.signer,
      storage: this.bridge,
      defaultTimeoutMilliseconds: this.limits.syncTimeoutMilliseconds,
      onEphemeral: (topic: N.Topic, peer: N.PeerId, bytes: Uint8Array) => {
        try {
          if (this.closed) return
          const key = topicKey(topic.toBytes())
          const tree = sedimentreeId(
            key.endsWith("0".repeat(32)) ? key.slice(0, 32) : key
          )
          if (this.deleting.has(tree)) return
          const watches = [...this.watches].filter(
            ([watch, id]) => id === tree && watch.active
          )
          if (!watches.length) return
          const message = decodeEphemeral(bytes)
          if (!message) return
          const event: SedimentreeEvent = {
            type: "ephemeral",
            sequence: ++this.sequence,
            message,
            sender: this.peerIdentity(peer),
          }
          for (const [watch] of watches)
            watch.push(event, bytes.byteLength, true)
        } finally {
          peer.free()
          topic.free()
        }
      },
      onRemoteHeads: (
        id: N.SedimentreeId,
        peer: N.PeerId,
        heads: N.CommitId[]
      ) => {
        try {
          if (this.closed) return
          const tree = logicalId(id)
          if (this.deleting.has(tree)) return
          const event: SedimentreeEvent = {
            type: "remote-heads",
            sequence: ++this.sequence,
            remote: this.peerIdentity(peer),
            heads: heads.map(h => commitId(h.toHexString())),
          }
          for (const [watch, watched] of this.watches)
            if (watched === tree) watch.push(event, 96 + heads.length * 32)
        } finally {
          heads.forEach(h => h.free())
          peer.free()
          id.free()
        }
      },
    })
  }
  private peerIdentity(peer: N.PeerId): BackendIdentity {
    return { kind: "subduction", id: peer.toString(), path: [] }
  }
  /** Borrow the authenticated wrapper until this promise settles. On success,
   * the engine owns a connection clone and disconnects it on close.
   * Keep the underlying JS transport alive until disconnection. Authentication
   * is the caller's responsibility; no document handle is materialized here.
   *
   * Open streams sync the new connection themselves, and native serves peer
   * requests for any stored tree, so stored-but-unopened documents are not
   * replayed here (matching Repo's historical connect behaviour).
   */
  async addConnection(transport: AuthenticatedTransport): Promise<boolean> {
    this.check("synchronize")
    try {
      return await this.engine.addConnection(transport)
    } catch (cause) {
      throw error("synchronize", cause)
    }
  }
  private reconcileInterest(id: SedimentreeId): void {
    if (this.closed) return
    const desired =
      !this.deleting.has(id) &&
      [...this.watches].some(([watch, tree]) => tree === id && watch.active)
    if (desired === this.interests.has(id)) return
    // Native may update its local interest before a control send fails.
    // Record the attempted state so a released observer still cleans up.
    if (desired) this.interests.add(id)
    else this.interests.delete(id)
    void (async () => {
      const native = nativeId(id)
      const topic = N.Topic.fromBytes(native.toBytes())
      native.free()
      try {
        if (desired) await this.engine.subscribeEphemeral([topic])
        else await this.engine.unsubscribeEphemeral([topic])
      } finally {
        topic.free()
      }
    })().catch(cause => {
      if (this.closed) return
      for (const [watch, tree] of this.watches)
        if (tree === id && watch.active)
          watch.push(
            {
              type: "failure",
              sequence: ++this.sequence,
              error: error("ephemeral", cause),
            },
            64,
            true
          )
    })
  }
  /** Propagate a store without an open session; one round per store. */
  private scheduleSync(id: SedimentreeId): void {
    if (this.closed || this.deleting.has(id)) return
    void this.syncRound(id).catch(cause => {
      if (!this.closed && !this.deleting.has(id))
        for (const [watch, tree] of this.watches)
          if (tree === id)
            watch.push({
              type: "failure",
              sequence: ++this.sequence,
              error: error("synchronize", cause),
            })
    })
  }
  private async syncRound(
    id: SedimentreeId,
    recipient?: Watch<SedimentreeEvent>
  ): Promise<SyncRoundResult> {
    this.check("synchronize", id)
    const engine = this.engine
    const roundId = `subduction-${++this.round}`
    const native = nativeId(id)
    let peers: N.PeerId[] = []
    try {
      peers = await engine.getConnectedPeerIds()
      // Store-triggered rounds only propagate; with no peers there is nothing
      // to do or report. Explicit rounds always answer their session.
      if (!peers.length && !recipient)
        return {
          roundId,
          marker: { sequence: ++this.sequence, heads: [] },
          outcome: "no-peers",
          peers: [],
        }
      const outcomes: SyncRoundResult["peers"][number][] = []
      for (const peer of peers) {
        const identity = this.peerIdentity(peer)
        try {
          const response = await engine.syncWithPeer(
            peer,
            native,
            true,
            this.limits.syncTimeoutMilliseconds
          )
          try {
            const failures = response.transportErrors
            outcomes.push({
              peer: identity,
              outcome: response.success ? "complete" : "failed",
              ...(failures.length
                ? {
                    error: error(
                      "synchronize",
                      new AggregateError(
                        failures,
                        "Peer synchronization failed"
                      )
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
            })
          } finally {
            response.free()
          }
        } catch (cause) {
          outcomes.push({
            peer: identity,
            outcome: "failed",
            error: error("synchronize", cause),
          })
        }
      }
      this.check("synchronize", id)
      let result!: SyncRoundResult
      const publish = (marker: HistoryMarker) => {
        result = {
          roundId,
          marker,
          outcome: !peers.length
            ? "no-peers"
            : outcomes.every(p => p.outcome === "complete")
              ? "complete"
              : "failed",
          peers: outcomes,
        }
        if (!this.closed && !this.deleting.has(id))
          for (const [watch, tree] of this.watches)
            if (tree === id && (!recipient || watch === recipient))
              watch.push(
                { type: "synchronized", result },
                64 + result.marker.heads.length * 32 + outcomes.length * 128
              )
      }
      publish(await this.headsMarker(native))
      return result
    } finally {
      peers.forEach(peer => peer.free())
      native.free()
    }
  }
  private check(operation: BackendOperation, id?: SedimentreeId): void {
    if (this.closed)
      throw new BackendError(operation, "closed", "Backend is closed")
    if (id && this.deleting.has(id))
      throw new BackendError(operation, "deleted", "Deletion barrier is active")
  }
  /** Stream items follow native's cache update, so native heads include them. */
  private async liveMarker(
    watch: Watch<SedimentreeEvent>,
    native: N.SedimentreeId
  ): Promise<void> {
    // Markers only establish readiness; completed sessions no longer need them.
    if (this.completed.has(watch)) return
    const target = await this.headsMarker(native)
    watch.push(
      { type: "history-marker", marker: target },
      32 + target.heads.length * 32
    )
  }
  private async headsMarker(native: N.SedimentreeId): Promise<HistoryMarker> {
    const heads = (await this.engine.getHeads(native)) ?? []
    try {
      return {
        sequence: ++this.sequence,
        heads: heads.map(head => commitId(head.toHexString())).sort(),
      }
    } finally {
      heads.forEach(head => head.free())
    }
  }
  open(input: SedimentreeId): SedimentreeSession {
    const id = sedimentreeId(input)
    this.check("open", id)
    let released = false
    let stream: N.StoredUpdates | undefined
    let initialized = false
    let resuming = false
    const watch = new Watch<SedimentreeEvent>(
      this.limits.replayEvents,
      this.limits.replayBytes,
      copyEvent,
      () => ({ type: "rescan-required", sequence: ++this.sequence }),
      () => {
        released = true
        stream?.close()
        this.watches.delete(watch)
        if (!resuming && ![...this.watches.values()].includes(id))
          this.recovering.delete(id)
        this.completed.delete(watch)
        this.reconcileInterest(id)
      }
    )
    // Keep sync and peer events that arrive while a first load waits on peers.
    watch.bufferBeforeInitialize()
    this.watches.set(watch, id)
    // One native stream per session keeps syncing across connections.
    const observe = async (): Promise<void> => {
      this.check("open", id)
      if (released) return
      const native = nativeId(id)
      const updates = this.engine.loadAndWatch(native)
      stream = updates
      const marker = () => this.liveMarker(watch, native)
      // Only storage scans are batched; peer and local updates flow live.
      let snapshot: Uint8Array[] | undefined = []
      const deliver = async (noPeers = false) => {
        const blobs = snapshot!
        snapshot = undefined
        if (!initialized) {
          initialized = true
          const sequence = ++this.sequence
          watch.initialize([
            ...(blobs.length
              ? [{ type: "blobs" as const, sequence, blobs }]
              : []),
            {
              type: "local-load-complete",
              found: blobs.length > 0,
              backendSyncs: true,
              ...(noPeers ? { noPeers: true } : {}),
            },
          ])
          this.reconcileInterest(id)
        } else {
          if (blobs.length)
            watch.push(
              { type: "blobs", sequence: ++this.sequence, blobs },
              blobs.reduce((size, blob) => size + blob.byteLength, 0)
            )
          await marker()
        }
      }
      try {
        for await (const update of updates) {
          if (released) break
          if (update.type === "commit" || update.type === "fragment") {
            if (snapshot) {
              snapshot.push(update.blob)
              update.metadata.free()
              continue
            }
            const record = storedRecord(update)
            watch.push(
              {
                type: "records",
                sequence: ++this.sequence,
                phase: "live",
                records: [record],
              },
              recordBytes(record)
            )
            await marker()
            this.recovering.delete(id)
          } else if (update.type === "storageChecked") {
            if (!snapshot) continue
            if (!initialized && !snapshot.length) {
              const peers = await this.engine.getConnectedPeerIds()
              try {
                await deliver(!peers.length)
              } finally {
                peers.forEach(peer => peer.free())
              }
            } else await deliver()
          } else if (update.type === "peerSynced") {
            update.peerId.free()
          } else snapshot = []
        }
      } catch (cause) {
        if (released || this.closed) return
        if (initialized && !this.recovering.has(id)) {
          this.recovering.add(id)
          resuming = true
          watch.finish({ type: "rescan-required", sequence: ++this.sequence })
          return
        }
        throw cause
      } finally {
        updates.close()
        native.free()
      }
    }
    void observe().catch(cause =>
      watch.finish({
        type: "failure",
        sequence: ++this.sequence,
        error: error("open", cause, true),
      })
    )
    const sessionCheck = (op: BackendOperation) => {
      this.check(op, id)
      if (released) throw new BackendError(op, "closed", "Session is closed")
    }
    return {
      events: watch,
      synchronize: (options = {}) => {
        try {
          sessionCheck("synchronize")
          const work = this.syncRound(id, watch)
          void work.catch(cause =>
            watch.push({
              type: "failure",
              sequence: ++this.sequence,
              error: error("synchronize", cause),
            })
          )
          return waitOnly(work, options.signal)
        } catch (cause) {
          return Promise.reject(cause)
        }
      },
      publishEphemeral: async message => {
        sessionCheck("ephemeral")
        let bytes: Uint8Array
        try {
          bytes = encodeEphemeral(message)
        } catch (cause) {
          throw new BackendError(
            "ephemeral",
            "invalid-record",
            String(cause),
            false,
            { cause }
          )
        }
        const native = nativeId(id)
        const topic = N.Topic.fromBytes(native.toBytes())
        native.free()
        try {
          await this.engine.publishEphemeral(topic, bytes)
        } catch (cause) {
          throw error("ephemeral", cause)
        } finally {
          topic.free()
        }
      },
      markComplete: () => {
        if (!released) this.completed.add(watch)
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
    const id = sedimentreeId(
      options.documentId ?? crypto.getRandomValues(new Uint8Array(32))
    )
    await this.storeRecords(id, initialRecords, true)
    return id
  }
  store(input: SedimentreeId, batch: RecordBatch): Promise<void> {
    return this.storeRecords(input, batch)
  }
  private storeRecords(
    input: SedimentreeId,
    batch: RecordBatch,
    creating = false
  ): Promise<void> {
    try {
      const id = sedimentreeId(input)
      this.check("store", id)
      let records: SedimentreeRecord[]
      try {
        records = batch.map(copyRecord)
        if (
          records.some(
            r =>
              r.kind === "fragment" &&
              (r.boundary.length > 255 || r.checkpoints.length > 65535)
          )
        )
          throw new Error("Fragment metadata exceeds native wire count limits")
      } catch (cause) {
        throw new BackendError(
          "store",
          "invalid-record",
          String(cause),
          false,
          { cause }
        )
      }
      const operation = creating ? "create" : "store"
      const engine = this.engine
      const write = (async () => {
        const native = nativeId(id)
        let submitted = false
        try {
          if (creating) {
            const heads = (await engine.getHeads(native)) ?? []
            heads.forEach(head => head.free())
            if (heads.length)
              throw new BackendError(
                "create",
                "conflict",
                "Document already exists"
              )
          }
          // One native call: it signs everything, saves through the bridge
          // once and minimizes once. Automerge's own memory limit is reached
          // long before a batch is large enough to need splitting here.
          const inputs: N.CommitInput[] = []
          const fragments: N.FragmentInput[] = []
          try {
            for (const record of records) {
              // Input constructors consume their native payloads.
              if (record.kind === "commit")
                inputs.push(
                  new N.CommitInput(unsigned(native, record), record.blob)
                )
              else
                fragments.push(
                  new N.FragmentInput(
                    unsignedFragment(native, record),
                    record.blob
                  )
                )
            }
            // storeBuiltBatch consumes both kinds of input wrappers.
            submitted = true
            await engine.storeBuiltBatch(native, inputs, fragments)
          } finally {
            if (!submitted) {
              inputs.forEach(c => c.free())
              fragments.forEach(f => f.free())
            }
          }
        } finally {
          // Durability never waits for a peer; a round propagates stores even
          // without a document session. A failed write may still have made
          // some records durable; they must propagate too, and a retry of the
          // whole batch dedupes them.
          if (submitted) this.scheduleSync(id)
          native.free()
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
    const targets = ids?.map(sedimentreeId)
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
      const id = sedimentreeId(input)
      this.check("delete")
      if (this.deleting.has(id)) return this.deleting.get(id)!
      this.recovering.delete(id)
      const sequence = ++this.sequence
      for (const [watch, tree] of this.watches)
        if (tree === id) watch.finish({ type: "deleted", sequence })
      // Local stores accepted earlier land first, and flush covers the
      // removal. Native owns removal and should fence ingested writes and
      // peer sync for this tree.
      const earlier = this.acks.get(id)
      const work: Promise<void> = (async () => {
        await Promise.allSettled([earlier])
        const native = nativeId(id)
        try {
          await this.engine.removeSedimentree(native)
        } finally {
          native.free()
        }
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
    this.recovering.clear()
    // Disconnect at once so stalled peer waits end. Native close would cancel
    // accepted local stores and deletions, so let them settle first; their
    // failures belong to flush, not close. Native close drains its own tasks.
    const accepted = [...this.acks.values()]
    const disconnected = this.engine.disconnectAll()
    this.closing = (async () => {
      const stopped = await Promise.allSettled([disconnected, ...accepted])
      const closed = await Promise.allSettled([this.engine.close()])
      this.engine.free()
      const errors = [stopped[0], closed[0]].flatMap(r =>
        r.status === "rejected" ? [r.reason] : []
      )
      if (errors.length)
        throw new AggregateError(errors, "Backend close failed")
    })()
    // Install the close guard before observers or transports can re-enter.
    notifyBackendClosed(this)
    for (const watch of this.watches.keys()) watch.finish()
    return this.closing
  }
}
