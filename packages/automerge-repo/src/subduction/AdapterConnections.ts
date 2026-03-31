import { Subduction } from "@automerge/automerge-subduction"
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

  // ── Adapter management ──────────────────────────────────────────────

  addAdapter(
    adapter: NetworkAdapterInterface,
    serviceName: string,
    role: "connect" | "accept"
  ) {
    this.#adapters.push(adapter)
    adapter.on("peer-candidate", ({ peerId }) => {
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
