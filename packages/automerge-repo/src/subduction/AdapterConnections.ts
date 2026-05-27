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
  #generation = 0
  #isShutdown = false
  /**
   * Track which (adapter, remote peer id) pairs we've already started a
   * transport for. Some `NetworkAdapter` implementations emit
   * `peer-candidate` more than once for a single logical connection (e.g.
   * `MessageChannelNetworkAdapter` fires once on the `arrive` exchange and
   * again on the `welcome` reply). Without this guard we'd spawn two
   * concurrent Subduction handshakes over the same underlying channel,
   * their handshake bytes would interleave, decoding would fail, and both
   * connections would die.
   */
  #startedTransports = new WeakMap<NetworkAdapterInterface, Set<string>>()

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
    this.#startedTransports.set(adapter, new Set())
    adapter.on("peer-candidate", ({ peerId }) => {
      if (this.#isShutdown) return
      // Dedupe per (adapter, peerId). See `#startedTransports` for why.
      const seen = this.#startedTransports.get(adapter)
      if (seen?.has(peerId)) return
      seen?.add(peerId)
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
    } catch {
      // Transport connection failed (e.g. peer disconnected during handshake)
    } finally {
      this.#pendingTransports--
      this.#generation++
      this.#onChangeCallback?.()
    }
  }
}
