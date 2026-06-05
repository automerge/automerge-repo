import { Subduction } from "@automerge/automerge-subduction/slim"
import { NetworkAdapterInterface } from "../network/NetworkAdapterInterface.js"
import { NetworkAdapterTransport } from "./network.js"
import { PeerId } from "../types.js"
import { ConnectionManager } from "./ConnectionManager.js"

export class AdapterConnections implements ConnectionManager {
  #adapters: NetworkAdapterInterface[] = []
  #subduction: Promise<Subduction>
  #localPeerId: PeerId
  #onChangeCallback: (() => void) | null = null
  #pendingTransports = 0
  #connectedTransports = 0
  #generation = 0
  #isShutdown = false

  constructor(subduction: Promise<Subduction>, localPeerId: PeerId) {
    this.#subduction = subduction
    this.#localPeerId = localPeerId
  }

  // ── ConnectionManager interface ─────────────────────────────────────

  isConnecting(): boolean {
    if (this.#pendingTransports > 0) return true
    return this.#adapters.some(
      adapter => adapter.state().value === "connecting"
    )
  }

  isConnected(): boolean {
    return this.#connectedTransports > 0
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
      void this.#startTransport(adapter, serviceName, peerId, role)
    })
    void this.#watchAdapter(adapter)
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
    try {
      const subduction = await this.#subduction
      const transport = new NetworkAdapterTransport(
        adapter,
        this.#localPeerId,
        peerId
      )
      if (role === "accept") {
        await subduction.acceptTransport(transport, serviceName)
      } else {
        await subduction.connectTransport(transport, serviceName)
      }

      // Handshake succeeded — this transport is now a live, subscribed
      // peer. Count it as connected until the adapter reports the peer
      // gone. We listen on the adapter's own `peer-disconnected` event
      // rather than `transport.onDisconnect` because the latter is a
      // single-slot callback owned by subduction; overwriting it would
      // break subduction's connection lifecycle.
      this.#connectedTransports++
      const onPeerDisconnected = ({ peerId: gonePeerId }: { peerId: PeerId }) => {
        if (gonePeerId !== peerId) return
        adapter.off("peer-disconnected", onPeerDisconnected)
        this.#connectedTransports = Math.max(0, this.#connectedTransports - 1)
        this.#generation++
        this.#onChangeCallback?.()
      }
      adapter.on("peer-disconnected", onPeerDisconnected)
    } catch {
      // Transport connection failed (e.g. peer disconnected during handshake)
    } finally {
      this.#pendingTransports--
      this.#generation++
      this.#onChangeCallback?.()
    }
  }
}
