/* c8 ignore start */

import { EventEmitter } from "eventemitter3"
import { PeerId } from "../types.js"
import { Message } from "./messages.js"
import { StorageId } from "../storage/types.js"

/**
 * Describes a peer intent to the system
 * storageId: the key for syncState to decide what the other peer already has
 * isEphemeral: to decide if we bother recording this peer's sync state
 *
 */
export interface PeerMetadata {
  storageId?: StorageId
  isEphemeral?: boolean
}

/** An interface representing some way to connect to other peers
 *
 * @remarks
 * The {@link Repo} uses one or more `NetworkAdapter`s to connect to other peers.
 * Because the network may take some time to be ready the {@link Repo} will wait
 * until the adapter emits a `ready` event before it starts trying to use it
 *
 * The {@link NetworkAdapter} is an abstract class that can be used as a base to build a
 * custom network adapter. It is most useful as a simple way to add the necessary event
 * emitter functionality
 */
export interface NetworkAdapterInterface
  extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId
  peerMetadata?: PeerMetadata

  /** Called by the {@link Repo} to start the connection process
   *
   * @argument peerId - the peerId of this repo
   * @argument peerMetadata - how this adapter should present itself to other peers
   */
  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void

  /** Called by the {@link Repo} to send a message to a peer
   *
   * @argument message - the message to send
   */
  send(message: Message): void

  /** Called by the {@link Repo} to disconnect from the network */
  disconnect(): void
}

// events & payloads

export interface NetworkAdapterEvents {
  /** Emitted when the network is ready to be used */
  ready: (payload: OpenPayload) => void

  /** Emitted when the network is closed */
  close: () => void

  /** Emitted when the network adapter learns about a new peer */
  "peer-candidate": (payload: PeerCandidatePayload) => void

  /** Emitted when the network adapter learns that a peer has disconnected */
  "peer-disconnected": (payload: PeerDisconnectedPayload) => void

  /** Emitted when the network adapter receives a message from a peer */
  message: (payload: Message) => void
}

export interface OpenPayload {
  network: NetworkAdapterInterface
}

export interface PeerCandidatePayload {
  peerId: PeerId
  peerMetadata: PeerMetadata
}

export interface PeerDisconnectedPayload {
  peerId: PeerId
}
