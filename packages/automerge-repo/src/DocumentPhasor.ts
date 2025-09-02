import debug from "debug"
import { DocHandle, SyncInfo } from "./DocHandle.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import {
  DocMessage,
  DocumentUnavailableMessage,
  EphemeralMessage,
  MessageContents,
  RequestMessage,
  SyncMessage,
} from "./network/messages.js"
import { DocumentId, PeerId } from "./types.js"
import { next as Automerge } from "@automerge/automerge"
import { decode } from "./helpers/cbor.js"
import { Request } from "./phase/Request.js"
import { Loading } from "./phase/Loading.js"
import { Ready } from "./phase/Ready.js"
import { Unavailable } from "./phase/Unavailable.js"

interface SpawnPhasorArgs<T> {
  ourPeerId: PeerId
  documentId: DocumentId
  initialState: Automerge.Doc<T> | undefined
  networkReady: boolean
}

// A `DocumentPhasor` manages the lifecycle of a document as it transitions
// through several different phases. The general intent here is that the
// `DocumentPhasor` is a pretty self contained state machine, it does not
// share state with other parts of the system.
//
// To use a DocumentPhasor you create the phasor, then you either:
//
// a) Feed it `DocEvent`s via `DocumentPhasor.handleEvent` informing the phasor of changes to
//   the environment (such as a new connection)
// b) Modify the document managed by the DocumentPhasor using `DocumentPhasor.localChange`
//
// Both methods will return a `DocEffects`, which is a description of the things which have
// changed as a result of the operation.
//
// ## Phases
//
// The phasor manages the following phases:
//
// * loading
// * requesting
// * ready
// * unavailable
//
// ## Caller Responsibilities
//
// ### Loading the document
//
// The `DocEffects` returned by the `handleEvent` method will indicate whether
// it is necessary to load the document from storage. When an event returns
// `DocEffects.beginLoad: true` then the caller should load the document. When
// the load completes the caller should provide the result of the load via the
// "load_complete" event.
//
// ### Network Ready
//
// Initially a phasor is in a "network not ready" state. This means that it will not mark
// documents as unavailable until the "network_ready" event has been received. Callers
// should dispatch this event as soon as the network subsystem says it is ready.
//
// ### Connections
//
// Each `DocumentPhasor` manages it's own set of connected peers. The caller
// should notify the phasor of new connections as soon as it is aware of them
// via the "peer_added" `DocEvent`. Each peer added to a document also needs a
// sync state and a share policy before it can be used to send messages (or not,
// as the case maybe). Callers should provide these via the
// "peer_sync_state_loaded" and "peer_share_policy_loaded" events. If a peer
// disconnects the phasor should be notified via the "peer_removed" `DocEvent`.
//
// Connection management then usually looks like this:
//
// * On new peer-candidate
//   * Dispatch "peer_added" event
//   * Begin loading sync state
//   * Begin loading share policy
// * On peer sync state loaded
//   * Dispatch "peer_sync_state_loaded" event
// * On peer share policy loaded
//   * Dispatch "peer_share_policy_loaded" event
// * On peer-disconnected
//   * Dispatch "peer_removed" event
//
// It's important that the "peer_added" event be fired for all peers the caller
// knows about, even before sync states and share policies are loaded. This
// allows the phasor to make useful decisions about whether a document is
// unavailable.
//
// ## Implementation Notes
//
// Phases of the document lifecycle are represented by implementations of the `Phase`
// interface. The caller performs some modification to the state of the phasor via
// `localChange` or `handleEvent`. This change twiddles some part of state, either
// on the phasor or on the phase implementation. Then, once this is done the
// `#calculateEffects` method is called, this method does these things:
//
// * Figure out whether we should transition to a new phase by calling `Phase.transition`
// * Figure out whether anything has changed as a result of the new event (e.g. an updated sync state)
// * Generate new sync messages for every connected peer
//
// Phase transitions always happen after applying the new event and as a result of the
// `Phase.transition` method, which makes it easy to understand why transitions occur.
export class DocumentPhasor<T> {
  #currentPhase: Phase
  // All the peers we have been informed of by the caller
  #peers: Map<PeerId, PeerState> = new Map()
  #ourPeerId: PeerId
  #documentId: DocumentId
  #doc: Automerge.Doc<T>
  #log: debug.Debugger
  // Ephemeral messages which we need to send
  #outboundEphemeralMessages: Uint8Array[] = []
  // Ephemeral messages which we have received and need to forward
  #forwardedEphemeralMessages: EphemeralMessage[] = []
  // Ephemeral messages we have received
  #newEphemeralMessages: { senderId: PeerId; content: any }[] = []
  // Whether the network is ready for outbound requests
  #networkReady: boolean
  // Whether there is currently a load request in progress
  #loadState: "idle" | "requested" | "running"
  // This is a flag used to figure out what has changed the first time we call #calculateEffects
  #started = false

  constructor({
    ourPeerId,
    documentId,
    initialState,
    networkReady,
  }: SpawnPhasorArgs<T>) {
    this.#log = debug(
      `automerge-repo:(${ourPeerId}):DocumentPhasor:${documentId}`
    )
    if (initialState) {
      this.#doc = initialState
      this.#currentPhase = new Ready()
      this.#loadState = "idle"
    } else {
      this.#doc = Automerge.init()
      this.#currentPhase = new Loading()
      this.#loadState = "requested"
    }
    this.#ourPeerId = ourPeerId
    this.#documentId = documentId
    this.#networkReady = networkReady
  }

  get documentId(): DocumentId {
    return this.#documentId
  }

  doc(): Automerge.Doc<T> {
    return this.#doc
  }

  loadRunning(): boolean {
    return ["requested", "running"].includes(this.#loadState)
  }

  networkReady(): boolean {
    return this.#networkReady
  }

  /**
   *
   * @returns The peers who we are actively messaging (i.e. not peers who
   * haven't loaded yet or whom the sharepolicy returns false for)
   */
  activePeers(): PeerId[] {
    return Array.from(
      this.#peers
        .values()
        .filter(peerState => {
          return (
            peerState.syncState.state === "loaded" &&
            peerState.shouldShare.state === "loaded" &&
            peerState.shouldShare.shouldShare
          )
        })
        .map(peerState => peerState.peerId)
    )
  }

  phase(): PhaseName {
    return this.#currentPhase.name
  }

  log(): debug.Debugger {
    return this.#log
  }

  /**
   * Perform some modification to the document
   *
   * @param f - A callback which will be passed the automerge document and must return a new document as well as a result
   * @returns The `result` returned from the callback, as well as any effects triggered by the change
   */
  // Note that this can't be achieved via a `DocEvent` because we want to
  // capture the result of the callback to return and `handleEvent` only
  // returns a `DocEffects`
  localChange<R>(
    f: (doc: Automerge.Doc<T>) => { newDoc: Automerge.Doc<T>; result: R }
  ): { result: R; effects: Effects<T> } {
    const before = {
      doc: this.#doc,
      phase: this.#currentPhase,
      heads: Automerge.getHeads(this.#doc),
      activePeers: this.#activePeers(),
    }
    const { newDoc, result } = f(this.#doc)
    this.#doc = newDoc
    let effects = this.#calculateEffects(before)
    return { result, effects }
  }

  /**
   * Notify the phasor of changes in the environment or completed commands
   *
   * @param event - The event which has occurred
   * @returns
   */
  handleEvent(event: DocEvent<T>): Effects<T> {
    const before = {
      doc: this.#doc,
      phase: this.#currentPhase,
      heads: Automerge.getHeads(this.#doc),
      activePeers: this.#activePeers(),
    }
    switch (event.type) {
      case "network_ready":
        this.#networkReady = true
        break
      case "load_complete":
        this.#handleLoad(event.data)
        break
      case "peer_added": {
        let existing = this.#peers.get(event.peerId)
        if (existing && existing.syncState.state === "loaded") {
          // If this is a reconnect of an existing peer we need to clear out their sync state
          existing.syncState.syncState = Automerge.decodeSyncState(
            Automerge.encodeSyncState(existing.syncState.syncState)
          )
          existing.syncState.dirty = true
          existing.syncState.previousSyncState = null
          break
        }
        const peerState: PeerState = {
          peerId: event.peerId,
          syncState: { state: "loading", pendingSyncMessages: [] },
          shouldShare: { state: "loading" },
          receivedSyncMessage: false,
          lastRecv: null,
          lastSend: null,
        }
        this.#peers.set(event.peerId, peerState)
        this.#currentPhase.addPeer(event.peerId)
        break
      }
      case "peer_share_policy_loaded": {
        const peerState = this.#peers.get(event.peerId)
        if (peerState != null) {
          peerState.shouldShare = {
            state: "loaded",
            shouldShare: event.shouldShare,
          }
        }
        break
      }
      case "peer_sync_state_loaded": {
        const peerState = this.#peers.get(event.peerId)
        if (peerState != null) {
          let pendingMessages: DocMessage[] = []
          if (peerState.syncState.state === "loading") {
            pendingMessages = peerState.syncState.pendingSyncMessages
          }
          setSyncState(peerState, event.syncState)
          for (const msg of pendingMessages) {
            this.#receiveMessage(peerState.peerId, msg)
          }
        }
        break
      }
      case "peer_removed":
        this.#peers.delete(event.peerId)
        break
      case "sync_message_received":
        this.#receiveMessage(event.peerId, event.message)
        break
      case "outbound_ephemeral_message": {
        this.#outboundEphemeralMessages.push(event.message)
        break
      }
      case "reload": {
        this.#loadState = "requested"
        break
      }
      default:
        const exhaustivenessCheck: never = event
        throw new Error(`Unhandled event type: ${exhaustivenessCheck}`)
    }
    return this.#calculateEffects(before)
  }

  /**
   * Perform a no-op tick, returning anything which needs doing
   */
  tick(): Effects<T> {
    const before = {
      doc: this.#doc,
      phase: this.#currentPhase,
      heads: Automerge.getHeads(this.#doc),
      activePeers: this.#activePeers(),
    }
    return this.#calculateEffects(before)
  }

  #calculateEffects(before: {
    heads: Automerge.Heads
    doc: Automerge.Doc<T>
    phase: Phase | null
    activePeers: Set<PeerId>
  }): Effects<T> {
    if (!this.#started) {
      before.heads = []
      before.phase = null
      this.#started = true
    }
    this.#maybeTransition()

    // First, determine if the document has changed
    const headsAfter = Automerge.getHeads(this.#doc)
    // Only notify of changes if the document is in the ready state
    const shouldNotifyOfChange =
      !headsEqual(before.heads, headsAfter) &&
      before.phase?.name === "ready" &&
      this.#currentPhase.name === "ready"
    let change = null
    if (shouldNotifyOfChange) {
      change = {
        headsBefore: before.heads,
        headsAfter,
        docBefore: before.doc,
        docAfter: this.#doc,
        diff: Automerge.diff(this.#doc, before.heads, headsAfter),
      }
    }

    // Check if we need to begin loading
    let beginLoad = false
    if (
      this.#loadState === "requested" ||
      (this.#loadState === "idle" && this.#currentPhase.name === "loading")
    ) {
      beginLoad = true
      this.#loadState = "running"
    }

    const outboundMessages: MessageContents[] = []
    const newSyncStates = new Map()
    const remoteHeadsChanged: Map<
      PeerId,
      { before: Automerge.Heads; after: Automerge.Heads }
    > = new Map()

    // For each peer
    // * Generate any new messages
    // * Notify any observers if:
    //   * The sync state has changed
    //   * The remote heads have changed
    // * Enqueue any new ephemeral messages
    for (const [_peerId, peerState] of this.#peers.entries()) {
      // Generate new messages
      const msg = this.#generateMessage(peerState)
      if (msg != null) {
        outboundMessages.push(msg)
      }

      // Check if the sync state has changed
      if (peerState.syncState.state == "loaded" && peerState.syncState.dirty) {
        peerState.syncState.dirty = false

        // Notify observers of the new sync state
        newSyncStates.set(peerState.peerId, peerState.syncState.syncState)

        // Check if the remote heads have changed
        const previousHeads =
          peerState.syncState.previousSyncState?.theirHeads ?? []
        const currentHeads = peerState.syncState.syncState.theirHeads ?? []
        if (!headsEqual(previousHeads, currentHeads)) {
          remoteHeadsChanged.set(peerState.peerId, {
            before: previousHeads,
            after: currentHeads,
          })
        }
      }

      // Send ephemeral messages
      if (
        peerState.shouldShare.state == "loaded" &&
        peerState.shouldShare.shouldShare
      ) {
        for (const msg of this.#outboundEphemeralMessages) {
          outboundMessages.push({
            type: "ephemeral",
            targetId: peerState.peerId,
            documentId: this.#documentId,
            data: msg,
          })
        }
      }
    }
    // Reset ephemeral outbox to empty
    this.#outboundEphemeralMessages = []

    // Notify observers if the phase has changed
    let stateChange = null
    if (before.phase?.name !== this.#currentPhase.name) {
      stateChange = {
        before: before.phase?.name || "loading", // TODO: introduce a "starting" phase?
        after: this.#currentPhase.name,
      }
    }

    // Pop new received ephemeral messages
    const newEphemeralMessages = this.#newEphemeralMessages
    this.#newEphemeralMessages = []

    // Pop ephemeral messages to forward
    const forwardedEphemeralMessages = this.#forwardedEphemeralMessages
    this.#forwardedEphemeralMessages = []

    // Notify observers of any new peers (since the last observation)
    let newActivePeers = Array.from(
      this.#activePeers().difference(before.activePeers)
    )

    return {
      beginLoad,
      outboundMessages,
      forwardedEphemeralMessages,
      newEphemeralMessages,
      newSyncStates,
      remoteHeadsChanged,
      docChanged: change,
      newActivePeers,
      stateChange,
    }
  }

  #handleLoad(data: Uint8Array | null) {
    this.#log(
      `load complete with ${data?.length ?? 0} bytes while in phase: ${
        this.#currentPhase.name
      }`
    )
    this.#loadState = "idle"
    if (data !== null) {
      this.#doc = Automerge.loadIncremental(this.#doc, data)
    }
  }

  #maybeTransition() {
    let transition = this.#currentPhase.transition(this)
    while (transition != null) {
      this.#log("transitioning to ", transition.to)

      switch (transition.to) {
        case "ready":
          this.#currentPhase = new Ready()
          for (const [
            peerId,
            msgs,
          ] of transition.pendingSyncMessages.entries()) {
            for (const msg of msgs) {
              this.#receiveMessage(peerId, msg)
            }
          }
          break
        case "unavailable":
          this.#currentPhase = new Unavailable(transition.awaitingNotification)
          break
        case "requesting":
          this.#currentPhase = new Request(
            this.#ourPeerId,
            this.#documentId,
            this.#peers.values(),
            this.#log
          )
          for (const [
            peerId,
            msgs,
          ] of transition.pendingSyncMessages.entries()) {
            for (const msg of msgs) {
              this.#receiveMessage(peerId, msg)
            }
          }
          break
        case "loading":
          this.#currentPhase = new Loading()
          for (const [
            peerId,
            msgs,
          ] of transition.pendingSyncMessages.entries()) {
            for (const msg of msgs) {
              this.#receiveMessage(peerId, msg)
            }
          }
          break
        default:
          const exhaustiveCheck: never = transition
          throw new Error(`Unhandled transition: ${exhaustiveCheck}`)
      }

      // Check if we are already ready to transition to the next phase
      transition = this.#currentPhase.transition(this)
    }
  }

  #receiveMessage(sender: PeerId, msg: DocMessage) {
    if (msg.type === "ephemeral") {
      // Ephemeral messages might be sent by a peer we are not connected to
      // so we handle them before looking up the peer state
      this.#receiveEphemeralMessage(msg)
      return
    }
    const peerState = this.#peers.get(sender)
    if (!peerState)
      throw new Error(`receive sync message for unknown peer: ${sender}`)
    if (peerState.syncState.state === "loading") {
      peerState.syncState.pendingSyncMessages.push(msg)
      return
    }
    this.#log(
      `received message from ${sender} while in state ${
        this.#currentPhase.name
      }`
    )
    peerState.lastRecv = new Date()

    if (msg.type === "request" || msg.type === "sync") {
      // We need to track if we ever received a sync message from a peer so that
      // we know to share with peers for whom the sharepolicy returns true but
      // which have requested from us
      peerState.receivedSyncMessage = true
    }
    const result = this.#currentPhase.receiveMessage({
      doc: this.#doc,
      remotePeer: sender,
      syncState: peerState.syncState.syncState,
      msg,
    })
    if (result != null) {
      const { newDoc, newSyncState } = result
      this.#doc = newDoc as Automerge.Doc<T>
      setSyncState(peerState, newSyncState)
    }
  }

  #receiveEphemeralMessage(msg: EphemeralMessage) {
    let peerState = this.#peers.get(msg.senderId)
    if (peerState != null) {
      peerState.lastRecv = new Date()
    }
    try {
      const content = decode(msg.data)
      this.#newEphemeralMessages.push({
        senderId: msg.senderId,
        content,
      })
      for (const peerState of this.#peers.values()) {
        let shouldShare =
          peerState.shouldShare.state === "loading" &&
          peerState.shouldShare.state
        if (shouldShare || peerState.receivedSyncMessage) {
          this.#forwardedEphemeralMessages.push({
            ...msg,
            targetId: peerState.peerId,
          })
        }
      }
    } catch (error) {
      this.#log("error decoding ephemeral message: ", error)
    }
    return
  }

  #generateMessage(peerState: PeerState): MessageContents | undefined {
    if (peerState.syncState.state === "loading") {
      return
    }
    if (peerState.shouldShare.state === "loading") {
      return
    }
    if (!peerState.shouldShare.shouldShare) {
      if (!peerState.receivedSyncMessage) {
        // Only bail if we haven't specifically received a request for this document
        return
      }
    }
    const generated = this.#currentPhase.generateMessage({
      doc: this.#doc,
      docId: this.#documentId,
      remotePeer: peerState.peerId,
      syncState: peerState.syncState.syncState,
      shouldShare: peerState.shouldShare.shouldShare,
    })
    if (generated == null) return
    setSyncState(peerState, generated.newSyncState)
    peerState.lastSend = new Date()
    return generated.msg
  }

  #activePeers(): Set<PeerId> {
    return new Set(
      this.#peers
        .values()
        .filter(
          peerState => peerState.lastRecv != null || peerState.lastSend != null
        )
        .map(peerState => peerState.peerId)
    )
  }
}

export type DocEvent<T> =
  | { type: "network_ready" }
  | {
      type: "load_complete"
      data: Uint8Array | null
    }
  | {
      type: "reload"
    }
  | { type: "peer_added"; peerId: PeerId }
  | {
      type: "peer_sync_state_loaded"
      peerId: PeerId
      syncState: Automerge.SyncState
    }
  | { type: "peer_share_policy_loaded"; peerId: PeerId; shouldShare: boolean }
  | { type: "peer_removed"; peerId: PeerId }
  | { type: "sync_message_received"; peerId: PeerId; message: DocMessage }
  | { type: "outbound_ephemeral_message"; message: Uint8Array }

/**
 * The effects of some change to the document phasor
 */
export type Effects<T> = {
  /**
   * If this is true the caller should enqueue a load of the document from storage
   */
  beginLoad: boolean
  /** Messages which should be sent to the network subsystem */
  outboundMessages: MessageContents[]
  /** New ephemeral messages which should be sent to DocHandles */
  newEphemeralMessages: { senderId: PeerId; content: any }[]
  /** Ephemeral messages which should be forwarded to other peers */
  forwardedEphemeralMessages: EphemeralMessage[]
  /** Sync states which have changed */
  newSyncStates: Map<PeerId, Automerge.SyncState>
  /** Remote heads which have changed */
  remoteHeadsChanged: Map<
    PeerId,
    { before: Automerge.Heads; after: Automerge.Heads }
  >
  /** If the phase has changed, this is the old and new phase names */
  stateChange: {
    before: PhaseName
    after: PhaseName
  } | null
  /** If the phasor is in the ready state and the document has changed, this will contain the new document and the diff */
  docChanged: {
    headsBefore: Automerge.Heads
    headsAfter: Automerge.Heads
    docBefore: Automerge.Doc<T>
    docAfter: Automerge.Doc<T>
    diff: Automerge.Patch[]
  } | null
  /** any new "active" peers who have appeared. Active peers are ones who have a sync state and a share policy and we are syncing with */
  newActivePeers: PeerId[]
}

export type PeerState = {
  peerId: PeerId
  syncState:
    | {
        // The sync state is loaded
        state: "loaded"
        syncState: Automerge.SyncState
        // The previous sync state, if there was one
        previousSyncState: Automerge.SyncState | null
        // Whether the sync state has changed since the last #calculateEffects
        dirty: boolean
      }
    | { state: "loading"; pendingSyncMessages: DocMessage[] } // The sync state is still loading
  // The result of the sharepolicy
  shouldShare: { state: "loading" } | { state: "loaded"; shouldShare: boolean }
  // Whether we have ever received a sync message from ths peer. Used to determine if
  // we should share with them even if the share policy denies access (i.e. if someone
  // directly requests a document ID, wee always share it)
  receivedSyncMessage: boolean
  lastRecv: Date | null
  lastSend: Date | null
}

export type PhaseName = "loading" | "requesting" | "ready" | "unavailable"

/**
 * The representation of the phases of a document lifecycle
 */
export interface Phase {
  name: PhaseName
  /**
   * Called by the phasor when a new peer is added by a "peer_added" DocEvent
   * @param peerId
   */
  addPeer(peerId: PeerId): void
  /**
   * Called by the phasor when a peer is removed by a "peer_removed" DocEvent
   * @param peerId
   */
  removePeer(peerId: PeerId): void

  /**
   * Called for each peer the phasor is aware of in #calculateEffects
   *
   * @returns - A new sync state and a message to send to the peer, or null if no change
   */
  generateMessage(
    args: GenerateArgs
  ): { newSyncState: Automerge.SyncState; msg: MessageContents } | undefined
  /**
   * Called by the phasor when a message is received from a peer
   *
   * @returns - A new sync state and document if the message changed anything, null otherwise
   */
  receiveMessage(args: ReceiveArgs):
    | {
        newSyncState: Automerge.SyncState
        newDoc: Automerge.Doc<unknown>
      }
    | undefined
  /**
   * Called by the phasor to ask if the phasor should transition to a new phase
   * @param phasor
   */
  transition<T>(phasor: DocumentPhasor<T>): PhaseTransition | undefined
}

/**
 * Arguments passed to the `Phase.receiveMessage` function
 */
export type ReceiveArgs = {
  doc: Automerge.Doc<unknown>
  remotePeer: PeerId
  syncState: Automerge.SyncState
  msg: SyncMessage | RequestMessage | DocumentUnavailableMessage
}

/**
 * Arguments passed to the `Phase.generateMessage` function
 */
export type GenerateArgs = {
  docId: DocumentId
  doc: Automerge.Doc<unknown>
  remotePeer: PeerId
  syncState: Automerge.SyncState
  shouldShare: boolean
}

export type PhaseTransition =
  | {
      to: "ready"
      // Messages which should be applied after the transition
      pendingSyncMessages: Map<PeerId, DocMessage[]>
    }
  | {
      to: "unavailable"
      // Peers who should be notified of the document's unavailability after the
      // transition
      awaitingNotification: Set<PeerId>
    }
  | {
      to: "loading"
      // Messages which should be applied after the transition
      pendingSyncMessages: Map<PeerId, DocMessage[]>
    }
  | {
      to: "requesting"
      // Messages which should be applied after the transition
      pendingSyncMessages: Map<PeerId, DocMessage[]>
    }

/**
 * Set the peer sync state to some value, updating the dirty flag if necessary
 */
function setSyncState(peerState: PeerState, syncState: Automerge.SyncState) {
  let previousSyncState = null
  if (peerState.syncState.state === "loaded" && !peerState.syncState.dirty) {
    // Only update the previous sync state if it's not dirty so that the caller
    // gets notified of changes since their last observation
    previousSyncState = peerState.syncState.syncState
  }
  peerState.syncState = {
    state: "loaded",
    previousSyncState,
    syncState,
    dirty: true,
  }
}

export function headsEqual(
  heads1: Automerge.Heads,
  heads2: Automerge.Heads
): boolean {
  if (heads1.length !== heads2.length) {
    return false
  }
  for (let i = 0; i < heads1.length; i++) {
    if (heads1[i] !== heads2[i]) {
      return false
    }
  }
  return true
}
