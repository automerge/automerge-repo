/* c8 ignore start */

import { EventEmitter } from "eventemitter3"
import { NetworkAdapterEvents, PeerMetadata } from "../index.js"
import { PeerId } from "../types.js"
import { Message } from "./messages.js"
import {
  AdapterState,
  NetworkAdapterInterface,
} from "./NetworkAdapterInterface.js"
import { AdapterStateSignal } from "./AdapterStateSignal.js"
import { noop } from "../helpers/noop.js"

/** An interface representing some way to connect to other peers
 *
 * @remarks
 * The {@link Repo} uses one or more `NetworkAdapter`s to connect to other peers.
 * Because the network may take some time to be ready the {@link Repo} will wait
 * until the adapter emits a `ready` event before it starts trying to use it
 *
 * This utility class can be used as a base to build a custom network adapter. It
 * is most useful as a simple way to add the necessary event emitter functionality
 */
export abstract class NetworkAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements NetworkAdapterInterface
{
  peerId?: PeerId
  peerMetadata?: PeerMetadata
  #adapterState: AdapterStateSignal

  constructor() {
    super()
    this.#adapterState = new AdapterStateSignal("connecting")
    // Defer to a microtask so subclass field initializers (which run after
    // super() returns) have completed before we call the overridden whenReady().
    queueMicrotask(() => {
      void this.whenReady().then(
        () => {
          this.#adapterState.set("ready")
        },
        // whenReady() rejected: the adapter never became ready, so leave the
        // state at "connecting". Swallow so a failing adapter does not surface
        // as an unhandled rejection (Repo logs readiness failures separately).
        noop
      )
    })
  }

  state(): AdapterState {
    return this.#adapterState
  }

  abstract isReady(): boolean
  abstract whenReady(): Promise<void>

  /** Called by the {@link Repo} to start the connection process
   *
   * @param peerId - the peerId of this repo
   * @param peerMetadata - how this adapter should present itself to other peers
   */
  abstract connect(peerId: PeerId, peerMetadata?: PeerMetadata): void

  /** Called by the {@link Repo} to send a message to a peer
   *
   * @param message - the message to send
   */
  abstract send(message: Message): void

  /** Called by the {@link Repo} to disconnect from the network */
  abstract disconnect(): void
}
