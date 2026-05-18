import debug from "debug"
import {
  PeerId as SubductionPeerId,
  Subduction,
} from "@automerge/automerge-subduction/slim"
import { NetworkAdapterInterface } from "../network/NetworkAdapterInterface.js"
import { NetworkAdapterTransport } from "./network.js"
import { PeerId } from "../types.js"
import { ConnectionManager } from "./ConnectionManager.js"

/**
 * Invoked once per successful subduction handshake on an adapter-backed
 * transport. `subductionPeerId` is the value returned by
 * `acceptTransport` / `connectTransport`; `repoPeerId` is the
 * automerge-repo PeerId carried by the originating `peer-candidate`
 * event. See `SubductionSource` for the shared
 * `OnSubductionPeerBound` shape.
 */
export type OnAdapterPeerBound = (binding: {
  subductionPeerId: SubductionPeerId
  repoPeerId: PeerId
  adapter: NetworkAdapterInterface
  serviceName: string
  role: "connect" | "accept"
}) => void

export class AdapterConnections implements ConnectionManager {
  #adapters: NetworkAdapterInterface[] = []
  #subduction: Promise<Subduction>
  #localPeerId: PeerId
  #onChangeCallback: (() => void) | null = null
  #onPeerBound: OnAdapterPeerBound | null
  #pendingTransports = 0
  #generation = 0
  #isShutdown = false
  #log: debug.Debugger = debug("automerge-repo:subduction:adapters")

  constructor(
    subduction: Promise<Subduction>,
    localPeerId: PeerId,
    onPeerBound?: OnAdapterPeerBound
  ) {
    this.#subduction = subduction
    this.#localPeerId = localPeerId
    this.#onPeerBound = onPeerBound ?? null
  }

  // ── ConnectionManager interface ─────────────────────────────────────

  isConnecting(): boolean {
    if (this.#pendingTransports > 0) return true
    return this.#adapters.some(
      adapter => adapter.state().value === "connecting"
    )
  }

  generation(): number {
    return this.#generation
  }

  onChange(callback: () => void): void {
    this.#onChangeCallback = callback
  }

  shutdown(): void {
    this.#isShutdown = true
    this.#onChangeCallback = null
    this.#onPeerBound = null
  }

  // ── Adapter management ──────────────────────────────────────────────

  addAdapter(
    adapter: NetworkAdapterInterface,
    serviceName: string,
    role: "connect" | "accept"
  ) {
    this.#adapters.push(adapter)
    adapter.on("peer-candidate", ({ peerId }) => {
      if (this.#isShutdown) return
      // Increment synchronously so isConnecting() returns true
      // before the async handshake begins.
      this.#pendingTransports++
      this.#startTransport(adapter, serviceName, peerId, role)
    })
    this.#watchAdapter(adapter)
    adapter.connect(this.#localPeerId)
  }

  async #watchAdapter(adapter: NetworkAdapterInterface) {
    for await (const _nextState of adapter.state().watch()) {
      this.#generation++
      this.#onChangeCallback?.()
    }
  }

  async #startTransport(
    adapter: NetworkAdapterInterface,
    serviceName: string,
    peerId: PeerId,
    role: "connect" | "accept"
  ) {
    let subductionPeerId: SubductionPeerId | null = null
    try {
      const subduction = await this.#subduction
      const transport = new NetworkAdapterTransport(
        adapter,
        this.#localPeerId,
        peerId
      )
      subductionPeerId =
        role === "accept"
          ? await subduction.acceptTransport(transport, serviceName)
          : await subduction.connectTransport(transport, serviceName)
    } catch {
      // Transport connection failed (e.g. peer disconnected during handshake)
    } finally {
      this.#pendingTransports--
      this.#generation++
      this.#onChangeCallback?.()
    }

    // Notify outside the try/finally so a listener throw can't be
    // mistaken for a transport failure, and so the bookkeeping above
    // has already settled (consumers see the post-handshake state).
    if (subductionPeerId !== null && this.#onPeerBound !== null) {
      try {
        this.#onPeerBound({
          subductionPeerId,
          repoPeerId: peerId,
          adapter,
          serviceName,
          role,
        })
      } catch (e) {
        this.#log("onPeerBound threw for %s/%s: %O", serviceName, peerId, e)
      }
    }
  }
}
