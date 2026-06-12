import { next as A } from "@automerge/automerge/slim"
import { decode } from "cbor-x"
import { makeLogger, Logger } from "../Logger.js"
import { EventEmitter } from "eventemitter3"
import {
  DocHandle,
  DocHandleOutboundEphemeralMessagePayload,
} from "../DocHandle.js"
import {
  DocumentUnavailableMessage,
  EphemeralMessage,
  MessageContents,
  OpenDocMessage,
  RepoMessage,
  RequestMessage,
  SyncMessage,
  isRequestMessage,
} from "../network/messages.js"
import { DocumentId, PeerId } from "../types.js"
import { asyncThrottle } from "../helpers/throttle.js"
import { HashRing } from "../helpers/HashRing.js"
import type { DocumentQuery } from "../DocumentQuery.js"
import type { SyncStatePayload, DocSyncMetrics } from "./Synchronizer.js"

export type PeerDocumentStatus = "unknown" | "has" | "unavailable" | "wants"

export type SharePolicyState = "loading" | "announce" | "share" | "denied"

export interface ShareConfig {
  announce: (peerId: PeerId, documentId?: DocumentId) => Promise<boolean>
  access: (peerId: PeerId, documentId?: DocumentId) => Promise<boolean>
}

export interface PeerStatusPayload {
  peerId: PeerId
  documentId: DocumentId
  status: PeerDocumentStatus
}

/**
 * The state of a remote peer with respect to this document. "has" records the
 * heads the peer initially advertised so we can check whether we've caught up
 * before responding to requestors.
 */
type InternalPeerStatus =
  | { type: "unknown" }
  | { type: "has"; theirInitialHeads: string[] }
  | { type: "wants" }
  | { type: "unavailable" }
  | { type: "unavailable-notified" }

interface PeerState {
  sharePolicyState: SharePolicyState
  status: InternalPeerStatus
  syncState: A.SyncState | null // null while loading from storage
  pendingMessages: (SyncMessage | RequestMessage)[] // queued while syncState loads
  dirty: boolean // needs outbound sync message
  hasRequested: boolean // true if peer ever sent request/sync for this doc
}

interface DocSynchronizerEvents {
  message: (payload: MessageContents) => void
  "sync-state": (payload: SyncStatePayload) => void
  "open-doc": (arg: OpenDocMessage) => void
  "peer-status": (arg: PeerStatusPayload) => void
  metrics: (arg: DocSyncMetrics) => void
}

/**
 * DocSynchronizer runs the automerge sync protocol for a single document
 * against a set of peers.
 *
 * All external events (addPeer, removePeer, receiveMessage, handle change,
 * network ready) mutate state then call {@link #evaluate}, the single
 * decision function that inspects current state and determines what outbound
 * messages to send and how to update query availability.
 *
 * Key invariants enforced by #evaluate:
 *
 * 1. Don't initiate sync until storage has had a chance to find the document
 *    (wait for network ready) — avoids advertising wrong heads.
 * 2. Don't send "unavailable" to requesting peers until all non-requesting
 *    peers have responded.
 * 3. When a requesting peer ("wants") arrives and a supplier ("has") exists,
 *    wait until we've obtained the supplier's initial heads before responding
 *    to the requestor.
 * 4. While syncing from a supplier on behalf of a requestor, don't fan out
 *    requests to other peers — avoid duplicate work.
 * 5. New peer after unavailable → re-request (if share policy allows).
 * 6. Handle updates from other sources → send sync to interested peers.
 */
export class DocSynchronizer extends EventEmitter<DocSynchronizerEvents> {
  #log: Logger
  syncDebounceRate = 100

  #peers: Map<PeerId, PeerState> = new Map()
  #handle: DocHandle<unknown>
  #query: DocumentQuery<unknown>
  #shareConfig: ShareConfig
  #seenEphemeralMessages = new HashRing(1000)
  #networkReady: boolean = false

  constructor({
    handle,
    query,
    networkReady,
    shareConfig,
  }: {
    handle: DocHandle<unknown>
    query: DocumentQuery<unknown>
    networkReady: Promise<void>
    shareConfig: ShareConfig
  }) {
    super()
    this.#handle = handle
    this.#query = query
    this.#shareConfig = shareConfig
    query.sourcePending("automerge-sync")

    query.subscribe(() => {
      // Anything internal to the query changed — either the public state
      // transitioned (e.g. data arrived from storage) or the source mix
      // changed (e.g. a higher-priority source gave up). Mark peers dirty
      // so #evaluate sends new data when the handle has it, and re-run
      // #evaluate so we can act on the new source mix (e.g. stop deferring
      // availability decisions).
      for (const peer of this.#peers.values()) {
        if (peer.syncState) peer.dirty = true
      }
      // Use queueMicrotask to avoid re-entrancy: #evaluate calls
      // #updateAvailability which can trigger query transitions,
      // which would synchronously re-enter here.
      queueMicrotask(() => this.#evaluate())
    })

    const docId = handle.documentId.slice(0, 5)
    this.#log = makeLogger(`automerge-repo:docsync:${docId}`)

    handle.on(
      "heads-changed",
      asyncThrottle(async () => {
        // Mark all active peers dirty — we may have new exportable data to
        // send. Signature reconciliation can attach signatures without
        // producing patches, so listening to "change" would miss the moment
        // previously unsigned changes become sendable.
        for (const peer of this.#peers.values()) {
          if (peer.syncState) peer.dirty = true
        }
        this.#evaluate()
      }, this.syncDebounceRate)
    )

    handle.on("ephemeral-message-outbound", payload =>
      this.#broadcastToPeers(payload)
    )

    networkReady
      .then(() => {
        this.#networkReady = true
        this.#evaluate()
      })
      .catch(() => {})
  }

  get query(): DocumentQuery<unknown> {
    return this.#query
  }

  get documentId(): DocumentId {
    return this.#handle.documentId
  }

  // PUBLIC API

  /**
   * Adds a peer to the Synchronizer
   *
   * The synchronizer will wait for the syncstate and share policy to be resolved before
   * beginning synchronization with the peer. This means that messages received in the
   * meantime will be buffered and this is the purpose of the `messages` parameter.
   *
   * It is valid to call this method multiple times for the same peerId. Because we wait
   * for the sync state and share policy to be resolved before synchronizing we have to
   * decide what to do in the case of racing `addPeer` calls. The last call will take
   * precedence. In particular queued messages from earlier calls will be discarded. This
   * is important because the sync protocol expects in-order delivery. If we mix messages
   * from multiple connections which happen to be using the same peer ID then the sync
   * protocol can get stuck or otherwise confused.
   *
   * From the perspective of the callers of this function then this means that after any
   * `addPeer` call all messages delivered via `receiveMessage` must be from the same
   * connection. If a new connection appears then `addPeer` must be called again.
   *
   * @param peerId The remote ID of the peer we are adding
   * @param syncState
   */
  addPeer(
    peerId: PeerId,
    syncState: Promise<A.SyncState | undefined>,
    { messages = [] }: { messages?: (SyncMessage | RequestMessage)[] } = {}
  ): void {
    const previous = this.#peers.get(peerId)
    const isNewPeer = !previous

    // Create or reset peer state. Sync state starts null (loading).
    const peer: PeerState = {
      sharePolicyState: "loading",
      status: { type: "unknown" },
      syncState: null,
      pendingMessages: [...messages],
      dirty: true,
      hasRequested: false,
    }
    // Note that we completely replace any existing state here. This is necessary
    // because once the sync state and share policy are resolved we call
    // `#activatePeer` which processes pending messages. `#activatePeer` compares
    // the current peer state for the this peer ID with this peer state by reference.
    // Replacing the state means that `#activatePeer` will ignore all racing `addPeer`
    // except the most recent call
    this.#peers.set(peerId, peer)

    // If we don't have data yet, a new peer might provide it — re-mark
    // the sync source as pending to prevent premature unavailability.
    if (this.#query.peek().state !== "ready") {
      this.#query.sourcePending("automerge-sync")
    }

    Promise.all([syncState, this.#resolveSharePolicy(peerId)])
      .then(([syncState, sharePolicyState]) =>
        this.#activatePeer(peerId, peer, isNewPeer, syncState, sharePolicyState)
      )
      .catch(err => {
        this.#log.error(
          `Error loading sync state or share policy for ${peerId}: ${err}`
        )
        this.#activatePeer(peerId, peer, isNewPeer, undefined, "denied")
      })
  }

  removePeer(peerId: PeerId): void {
    this.#log.debug(`removing peer ${peerId}`)
    this.#peers.delete(peerId)
    this.emit("peer-status", {
      peerId,
      documentId: this.documentId,
      status: "unavailable",
    })
    this.#evaluate()
  }

  hasPeer(peerId: PeerId): boolean {
    return this.#peers.has(peerId)
  }

  receiveMessage(message: RepoMessage): void {
    switch (message.type) {
      case "sync":
      case "request":
        this.#receiveSyncMessage(message)
        break
      case "ephemeral":
        this.#receiveEphemeralMessage(message)
        break
      case "doc-unavailable":
        this.#setPeerStatus(message.senderId, { type: "unavailable" })
        break
      default:
        throw new Error(`unknown message type: ${(message as any).type}`)
    }
    this.#evaluate()
  }

  /**
   * Re-evaluate share policy for all peers. Called when the share config
   * functions may return different results (e.g. after Repo.shareConfigChanged).
   */
  reevaluateSharePolicy(): void {
    for (const peerId of Array.from(this.#peers.keys())) {
      this.#resolveSharePolicy(peerId)
        .then(newPolicy => {
          const peer = this.#peers.get(peerId)
          if (!peer) return
          if (peer.sharePolicyState === newPolicy) return

          peer.sharePolicyState = newPolicy

          if (newPolicy === "denied" && peer.hasRequested) {
            // Peer lost access — notify them
            this.emit("message", {
              type: "doc-unavailable",
              documentId: this.documentId,
              targetId: peerId,
            } as MessageContents<DocumentUnavailableMessage>)
          }

          peer.dirty = true
          this.#evaluate()
        })
        .catch(e => {
          this.#log.error(
            `error loading share policy in reevaluateSharePolicy: ${e}`
          )
        })
    }
  }

  /** Trigger sync with all current peers. */
  syncAllPeers(): void {
    for (const peer of this.#peers.values()) {
      if (peer.syncState) peer.dirty = true
    }
    this.#evaluate()
  }

  metrics(): { peers: PeerId[]; size: { numOps: number; numChanges: number } } {
    return {
      peers: Array.from(this.#peers.keys()),
      size: A.stats(this.#handle.fullDoc()),
    }
  }

  // SHARE POLICY

  async #resolveSharePolicy(peerId: PeerId): Promise<SharePolicyState> {
    const peer = this.#peers.get(peerId)
    const [announce, access] = await Promise.all([
      this.#shareConfig.announce(peerId, this.documentId),
      this.#shareConfig.access(peerId, this.documentId),
    ])
    if (announce) return "announce"
    const hasRequested = peer?.hasRequested ?? false
    if (access && hasRequested) return "announce"
    if (access) return "share"
    return "denied"
  }

  // THE EVALUATE LOOP

  /**
   * Inspects current state and determines:
   * 1. Which peers need outbound sync/request messages
   * 2. Whether to update query availability (pending vs unavailable)
   * 3. Whether to send doc-unavailable to wanting peers
   */
  #evaluate(): void {
    const doc = this.#handle.fullDoc()
    const weHaveData = A.getHeads(doc).length > 0
    const supplierExists = this.#anyActivePeerOfType("has")

    // Check whether we've caught up with all suppliers' initial heads.
    // Until we have, we shouldn't respond to requestors.
    const awaitingSupplierData =
      supplierExists && this.#hasPendingSupplierHeads(doc)

    // Phase 1: Send outbound sync messages to dirty peers.
    for (const [peerId, peer] of this.#peers) {
      if (peer.sharePolicyState === "loading") continue // share policy pending
      if (peer.sharePolicyState === "denied") continue // access denied
      // "share" peers only get messages after they've requested
      if (peer.sharePolicyState === "share" && peer.status.type === "unknown")
        continue
      if (!peer.syncState) continue // sync state still loading
      if (!peer.dirty) continue

      // If an earlier source is still deciding whether it can provide this
      // document, don't publish an outbound request that other peers may
      // interpret as evidence that we do not have it. This is how we wait
      // for the storage source to complete before announcing that a document
      // is unavailable (for example)
      if (
        !weHaveData &&
        peer.status.type === "unknown" &&
        this.#query.shouldDeferAvailability("automerge-sync")
      ) {
        continue
      }

      // Invariant 4: If we don't have data but a supplier exists,
      // only talk to the supplier. Don't fan out requests to other peers.
      if (!weHaveData && supplierExists && peer.status.type !== "has") {
        continue
      }

      // Invariant 3: If a supplier exists but we haven't caught up with
      // their initial heads yet, don't respond to requestors.
      if (awaitingSupplierData && peer.status.type !== "has") {
        continue
      }

      peer.dirty = false
      this.#sendSyncMessage(peerId, peer, doc)
    }

    // Phase 2: Update query availability. This may trigger query transitions
    // that fire subscribers (including our own), which queue a deferred
    // #evaluate via queueMicrotask. We do this before Phase 3 so that the
    // query state is up-to-date when we check whether to send doc-unavailable.
    this.#updateAvailability()

    // Phase 3: Notify wanting peers that the document is unavailable.
    // Only fires when the query has settled to unavailable/failed
    // and we have no data. The "unavailable-notified" status ensures each
    // peer is only told once.
    const queryState = this.#query.peek()
    if (
      !weHaveData &&
      (queryState.state === "unavailable" || queryState.state === "failed")
    ) {
      for (const [peerId, peer] of this.#peers) {
        if (peer.status.type === "wants") {
          this.#setPeerStatus(peerId, { type: "unavailable-notified" })
          this.emit("message", {
            type: "doc-unavailable",
            documentId: this.#handle.documentId,
            targetId: peerId,
          } as MessageContents<DocumentUnavailableMessage>)
        }
      }
    }
  }

  /**
   * Returns true if any "has" peer advertised initial heads that we
   * don't yet have locally.
   */
  #hasPendingSupplierHeads(doc: A.Doc<unknown>): boolean {
    for (const peer of this.#peers.values()) {
      if (peer.status.type !== "has") continue
      if (peer.sharePolicyState === "denied") continue
      if (!A.hasHeads(doc, peer.status.theirInitialHeads)) return true
    }
    return false
  }

  /**
   * Returns true if at least one "has" peer's advertised initial heads
   * are present in our doc — i.e. we have a complete copy from at least
   * one supplier.
   */
  #hasCaughtUpToAnySupplier(doc: A.Doc<unknown>): boolean {
    for (const peer of this.#peers.values()) {
      if (peer.status.type !== "has") continue
      if (peer.sharePolicyState === "denied") continue
      if (A.hasHeads(doc, peer.status.theirInitialHeads)) return true
    }
    return false
  }

  /**
   * Evaluate whether the sync source should be marked pending, ready, or
   * unavailable on the query. Denied peers are excluded — they don't
   * contribute data.
   *
   * - `pending`: there's a peer we're still waiting on (share policy
   *   loading, status unknown, or a `has` peer whose advertised initial
   *   heads we haven't reached).
   * - `ready`: at least one connected `has` peer's advertised initial
   *   heads are present in our doc — we have a complete copy from
   *   someone.
   * - `unavailable`: no connected peer ever advertised the doc.
   */
  #updateAvailability(): void {
    if (!this.#networkReady) return

    if (this.#peers.size === 0) {
      this.#query.sourceUnavailable("automerge-sync")
      return
    }

    // If any peer's share policy is still being evaluated, we don't yet
    // know the full set of peers — stay pending.
    if (this.#anyPeerWithSharePolicy("loading")) {
      this.#query.sourcePending("automerge-sync")
      return
    }

    // If any non-denied peer is still unknown, we might get data — stay pending.
    if (this.#anyActivePeerOfType("unknown")) {
      this.#query.sourcePending("automerge-sync")
      return
    }

    // If at least one `has` peer's advertised heads are already present
    // in our doc, we have a complete copy from a supplier — ready, even
    // if other suppliers have additional heads we haven't reached yet.
    if (this.#hasCaughtUpToAnySupplier(this.#handle.fullDoc())) {
      this.#query.sourceReady("automerge-sync")
      return
    }

    // There's at least one `has` peer but we haven't caught up to any of
    // them yet — stay pending.
    if (this.#anyActivePeerOfType("has")) {
      this.#query.sourcePending("automerge-sync")
      return
    }

    // No peer ever advertised the doc — all are unavailable / wants /
    // denied.
    this.#query.sourceUnavailable("automerge-sync")
  }

  // STATE MUTATION HELPERS

  /**
   * Called once the sync state and share policy promises resolve. Sets sync
   * state, drains queued messages in order, then marks the peer dirty for
   * #evaluate.
   */
  #activatePeer(
    peerId: PeerId,
    peer: PeerState,
    isNewPeer: boolean,
    syncState: A.SyncState | undefined,
    sharePolicyState: SharePolicyState
  ): void {
    // Peer may have been removed while we were loading, or addPeer may have
    // been called again. In either case, this activation is stale. (note this
    // comparison is by reference which works because we reset the state in
    // `addPeer`)
    if (this.#peers.get(peerId) !== peer) return

    // Round-trip through encoding to prevent infinite loop from stale state.
    let state: A.SyncState
    if (syncState) {
      state = A.decodeSyncState(A.encodeSyncState(syncState))
    } else if (peer.syncState) {
      state = A.decodeSyncState(A.encodeSyncState(peer.syncState))
    } else {
      state = A.initSyncState()
    }

    peer.syncState = state
    this.emit("sync-state", {
      peerId,
      syncState: state,
      documentId: this.#handle.documentId,
    })

    peer.sharePolicyState = sharePolicyState

    // Denied peers: keep them in the map but don't activate normally.
    if (sharePolicyState === "denied") {
      // Respond to any queued messages with doc-unavailable. Both request
      // and sync messages count as interaction — we mark hasRequested so
      // that if the share policy later flips to allow, the peer is
      // re-engaged via reevaluateSharePolicy.
      const queued = peer.pendingMessages
      peer.pendingMessages = []
      for (const _msg of queued) {
        peer.hasRequested = true
        this.emit("message", {
          type: "doc-unavailable",
          documentId: this.documentId,
          targetId: peerId,
        } as MessageContents<DocumentUnavailableMessage>)
      }
      this.#evaluate()
      return
    }

    // Only emit "open-doc" when the peer has actually interacted with
    // this document. "announce" peers are proactively shared with, and
    // peers with pending messages have explicitly requested the doc.
    // "share" peers without pending messages are just passively available.
    if (
      isNewPeer &&
      (sharePolicyState === "announce" || peer.pendingMessages.length > 0)
    ) {
      this.emit("open-doc", { documentId: this.documentId, peerId })
    }

    // Drain queued messages in order.
    const queued = peer.pendingMessages
    peer.pendingMessages = []
    for (const msg of queued) {
      this.#receiveSyncMessage(msg)
    }

    // After draining, mark dirty so #evaluate sends the initial sync.
    peer.dirty = true
    this.#evaluate()
  }

  #setPeerStatus(peerId: PeerId, status: InternalPeerStatus): void {
    const peer = this.#peers.get(peerId)
    if (!peer) return
    if (peer.status.type === status.type) return
    peer.status = status
    // Emit the public-facing status (collapse internal variants).
    const externalStatus: PeerDocumentStatus =
      status.type === "unavailable-notified" ? "unavailable" : status.type
    this.emit("peer-status", {
      peerId,
      documentId: this.documentId,
      status: externalStatus,
    })
  }

  /**
   * Returns true if any non-denied peer has the given status type.
   */
  #anyActivePeerOfType(type: InternalPeerStatus["type"]): boolean {
    for (const peer of this.#peers.values()) {
      if (peer.sharePolicyState === "denied") continue
      if (peer.status.type === type) return true
    }
    return false
  }

  #anyPeerWithSharePolicy(state: SharePolicyState): boolean {
    for (const peer of this.#peers.values()) {
      if (peer.sharePolicyState === state) return true
    }
    return false
  }

  // SYNC PROTOCOL

  #sendSyncMessage(peerId: PeerId, peer: PeerState, doc: A.Doc<unknown>): void {
    this.#log.debug(`sendSyncMessage ->${peerId}`)

    const syncState = peer.syncState!
    const isNew = A.getHeads(doc).length === 0

    const start = performance.now()
    const [newSyncState, message] = A.generateSyncMessage(doc, syncState)
    const end = performance.now()
    this.emit("metrics", {
      type: "generate-sync-message",
      documentId: this.#handle.documentId,
      durationMillis: end - start,
      forPeer: peerId,
    })

    peer.syncState = newSyncState
    this.emit("sync-state", {
      peerId,
      syncState: newSyncState,
      documentId: this.#handle.documentId,
    })

    if (!message) return

    if (
      isNew &&
      newSyncState.sharedHeads.length === 0 &&
      peer.status.type === "unknown"
    ) {
      // We don't have the document, so this is a request.
      this.emit("message", {
        type: "request",
        targetId: peerId,
        documentId: this.#handle.documentId,
        data: message,
      } as RequestMessage)
    } else {
      this.emit("message", {
        type: "sync",
        targetId: peerId,
        data: message,
        documentId: this.#handle.documentId,
      } as SyncMessage)
    }
  }

  #receiveSyncMessage(message: SyncMessage | RequestMessage): void {
    if (message.documentId !== this.#handle.documentId)
      throw new Error(`channelId doesn't match documentId`)

    const peer = this.#peers.get(message.senderId)
    if (!peer) {
      throw new Error(
        `No peer state for ${message.senderId} on document ` +
          `${this.#handle.documentId}. This indicates a logic error: ` +
          `addPeer must be called before receiving messages from a peer.`
      )
    }

    // Track that this peer has requested/sent data for this document.
    // Emit open-doc on first interaction for "share" peers (announce peers
    // already emitted it during activation).
    if (!peer.hasRequested && peer.sharePolicyState === "share") {
      this.emit("open-doc", {
        documentId: this.documentId,
        peerId: message.senderId,
      })
    }
    peer.hasRequested = true

    // Update peer status based on message type.
    if (isRequestMessage(message)) {
      this.#setPeerStatus(message.senderId, { type: "wants" })
    }
    const decoded = A.decodeSyncMessage(message.data)
    if (decoded.heads.length > 0) {
      this.#setPeerStatus(message.senderId, {
        type: "has",
        theirInitialHeads: decoded.heads,
      })
    }

    // If sync state is still loading, queue for later.
    if (!peer.syncState) {
      peer.pendingMessages.push(message)
      return
    }

    // Denied peers: track status above but don't apply sync data.
    if (peer.sharePolicyState === "denied") {
      this.emit("message", {
        type: "doc-unavailable",
        documentId: this.#handle.documentId,
        targetId: message.senderId,
      } as MessageContents<DocumentUnavailableMessage>)
      return
    }

    let receivedNewDoc = false
    this.#handle.update(
      doc => {
        const start = performance.now()
        const [newDoc, newSyncState] = A.receiveSyncMessage(
          doc,
          peer.syncState!,
          message.data
        )
        receivedNewDoc = newDoc !== doc
        const end = performance.now()
        this.emit("metrics", {
          type: "receive-sync-message",
          documentId: this.#handle.documentId,
          durationMillis: end - start,
          fromPeer: message.senderId,
          ...A.stats(doc),
        })

        peer.syncState = newSyncState
        this.emit("sync-state", {
          peerId: message.senderId,
          syncState: newSyncState,
          documentId: this.#handle.documentId,
        })

        // Mark this peer dirty so #evaluate sends a response.
        peer.dirty = true

        return newDoc
      },
      {
        // Receiving signed remote changes can update Automerge's internal
        // pending-verification queue without changing materialized heads. Emit
        // a synthetic heads-changed event so Repo's signature reconciliation
        // asks the application verifier whether those changes may materialize.
        forceHeadsChanged: (_before, after) =>
          receivedNewDoc && A.signingEnabled(after),
      }
    )
  }

  // EPHEMERAL MESSAGES

  #broadcastToPeers({
    data,
  }: DocHandleOutboundEphemeralMessagePayload<unknown>): void {
    this.#log.debug(`broadcastToPeers`, Array.from(this.#peers.keys()))
    for (const [peerId, peer] of this.#peers) {
      if (
        peer.sharePolicyState === "denied" ||
        peer.sharePolicyState === "loading"
      )
        continue
      // "share" peers only get broadcasts after they've interacted
      if (peer.sharePolicyState === "share" && peer.status.type === "unknown")
        continue
      this.#sendEphemeralMessage(peerId, data)
    }
  }

  #sendEphemeralMessage(peerId: PeerId, data: Uint8Array): void {
    this.#log.debug(`sendEphemeralMessage ->${peerId}`)
    const message: MessageContents<EphemeralMessage> = {
      type: "ephemeral",
      targetId: peerId,
      documentId: this.#handle.documentId,
      data,
    }
    this.emit("message", message)
  }

  #receiveEphemeralMessage(message: EphemeralMessage): void {
    if (message.documentId !== this.#handle.documentId)
      throw new Error(`channelId doesn't match documentId`)

    const { senderId, sessionId, count, data } = message
    const messageId = `${senderId}:${sessionId}:${count}`
    const isNewMessage = this.#seenEphemeralMessages.add(messageId)

    // In a mesh network the same message can arrive from multiple peers.
    // Only emit and forward it once per unique sender/session/count.
    if (!isNewMessage) return

    const contents = decode(new Uint8Array(data))
    // Inject the inbound message at the document level; the registry
    // fans it out to every retained handle (root, sub, view).
    this.#handle._receiveInboundEphemeral(senderId, contents)

    for (const [peerId, peer] of this.#peers) {
      if (peerId === senderId) continue
      if (
        peer.sharePolicyState === "denied" ||
        peer.sharePolicyState === "loading"
      )
        continue
      if (peer.sharePolicyState === "share" && peer.status.type === "unknown")
        continue
      this.emit("message", { ...message, targetId: peerId })
    }
  }
}
