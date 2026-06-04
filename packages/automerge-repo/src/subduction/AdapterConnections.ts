import { PeerId as SubductionPeerId, Subduction } from "@automerge/automerge-subduction/slim"
import debug from "debug"
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
  #log = debug("automerge-repo:subduction:adapters")

  /**
   * repo PeerId.toString() → SubductionPeerId captured after a successful
   * acceptTransport/connectTransport. Used to call disconnectFromPeer when
   * the adapter peer goes away, so Subduction's Rust core removes the dead
   * slot from future fullSyncWithAllPeers targets.
   */
  #boundPeers = new Map<string, SubductionPeerId>()
  /** PeerIds for which peer-disconnected fired before #boundPeers was set. */
  #pendingDisconnects = new Set<string>()

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
    this.#boundPeers.clear()
    this.#pendingDisconnects.clear()
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
    adapter.on("peer-disconnected", ({ peerId }) => {
      if (this.#isShutdown) return
      const peerKey = peerId.toString()
      const subductionPeerId = this.#boundPeers.get(peerKey)
      if (subductionPeerId !== undefined) {
        this.#boundPeers.delete(peerKey)
        void this.#disconnectFromSubductionPeer(subductionPeerId, peerId)
      } else {
        // Peer disconnected before #startTransport could store it in #boundPeers.
        // Record it so #startTransport can evict it immediately after handshake.
        this.#pendingDisconnects.add(peerKey)
      }
    })
    void this.#watchAdapter(adapter)
    adapter.connect(this.#localPeerId)
  }

  async #disconnectFromSubductionPeer(
    subductionPeerId: SubductionPeerId,
    repoPeerId: PeerId
  ): Promise<void> {
    try {
      const subduction = await this.#subduction
      const found = await subduction.disconnectFromPeer(subductionPeerId)
      if (found) {
        this.#log("disconnected subduction peer for %s", repoPeerId)
      } else {
        this.#log("subduction peer for %s was already gone", repoPeerId)
      }
    } catch (e) {
      this.#log("disconnectFromPeer threw for %s: %O", repoPeerId, e)
    } finally {
      this.#generation++
      this.#onChangeCallback?.()
    }
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
    const peerKey = peerId.toString()
    if (subductionPeerId !== null) {
      if (this.#pendingDisconnects.has(peerKey)) {
        this.#pendingDisconnects.delete(peerKey)
        void this.#disconnectFromSubductionPeer(subductionPeerId, peerId)
      } else {
        this.#boundPeers.set(peerKey, subductionPeerId)
      }
    } else {
      // Handshake failed — drop any stale pending-disconnect flag so a future
      // successful reconnect for this peer is not incorrectly evicted.
      this.#pendingDisconnects.delete(peerKey)
    }
  }
}
