import { EventEmitter } from "eventemitter3"
import { PeerId } from "../types.js"
import { Message } from "./messages.js"

/** An interface representing some way to connect to other peers
 *
 * @remarks
 * The {@link Repo} uses one or more `NetworkAdapter`s to connect to other peers.
 * Because the network may take some time to be ready the {@link Repo} will wait
 * until the adapter emits a `ready` event before it starts trying to use it
 */
export abstract class NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId // hmmm, maybe not

  /** Called by the {@link Repo} to start the connection process
   *
   * @argument peerId - the peerId of this repo
   */
  abstract connect(peerId: PeerId): void

  /** Called by the {@link Repo} to send a message to a peer
   *
   * @argument message - the message to send
   */
  abstract send(message: Message): void

  /** Called by the {@link Repo} to disconnect from the network */
  abstract disconnect(): void
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
  network: NetworkAdapter
}

export interface PeerCandidatePayload {
  peerId: PeerId
}

export interface PeerDisconnectedPayload {
  peerId: PeerId
}
