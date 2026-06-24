import { Subduction } from "@automerge/automerge-subduction/slim"
import { NetworkAdapterInterface } from "../network/NetworkAdapterInterface.js"
import { NetworkAdapterTransport } from "./network.js"
import { PeerId } from "../types.js"
import { ConnectionManager } from "./ConnectionManager.js"

type AdapterRole = "connect" | "accept"

/**
 * Per-adapter bookkeeping so an adapter registered after construction can
 * later be removed cleanly (unsubscribe its listeners, stop its state-watch
 * loop, and tear down any transports it spun up). Without this, a long-lived
 * "accept" node — e.g. a SharedWorker serving one MessageChannel per tab —
 * would leak a listener and a suspended watch loop on every tab that comes
 * and goes.
 *
 * `transportsByPeer` also dedupes: some adapters announce a peer more than
 * once (the MessageChannel adapter fires `peer-candidate` on both `arrive`
 * and `welcome`). Establishing a second Subduction transport for a peer we
 * already have one for makes the two connections race and tear each other
 * down, so we keep at most one transport per peer. A `null` value reserves a
 * peer slot synchronously while its transport is still being established.
 */
type AdapterRecord = {
  adapter: NetworkAdapterInterface
  serviceName: string
  role: AdapterRole
  onPeerCandidate: (payload: { peerId: PeerId }) => void
  onPeerDisconnected: (payload: { peerId: PeerId }) => void
  transportsByPeer: Map<string, NetworkAdapterTransport | null>
  removed: boolean
}

export class AdapterConnections implements ConnectionManager {
  #records = new Map<NetworkAdapterInterface, AdapterRecord>()
  #subduction: Promise<Subduction>
  #localPeerId: PeerId
  #onChangeCallback: (() => void) | null = null
  #pendingTransports = 0
  #generation = 0
  #isShutdown = false

  constructor(subduction: Promise<Subduction>, localPeerId: PeerId) {
    this.#subduction = subduction
    this.#localPeerId = localPeerId
  }

  // ── ConnectionManager interface ─────────────────────────────────────

  isConnecting(): boolean {
    if (this.#pendingTransports > 0) return true
    for (const { adapter } of this.#records.values()) {
      if (adapter.state().value === "connecting") return true
    }
    return false
  }

  generation(): number {
    return this.#generation
  }

  onChange(callback: () => void): void {
    this.#onChangeCallback = callback
  }

  shutdown(): void {
    this.#isShutdown = true
    for (const adapter of [...this.#records.keys()]) {
      this.removeAdapter(adapter)
    }
    this.#onChangeCallback = null
  }

  // ── Adapter management ──────────────────────────────────────────────

  addAdapter(
    adapter: NetworkAdapterInterface,
    serviceName: string,
    role: AdapterRole
  ) {
    if (this.#isShutdown) return
    // Idempotent: re-adding the same adapter is a no-op rather than a
    // double-connect (which would double-announce peers).
    if (this.#records.has(adapter)) return

    const record: AdapterRecord = {
      adapter,
      serviceName,
      role,
      onPeerCandidate: () => {},
      onPeerDisconnected: () => {},
      transportsByPeer: new Map(),
      removed: false,
    }
    record.onPeerCandidate = ({ peerId }: { peerId: PeerId }) => {
      if (this.#isShutdown || record.removed) return
      const key = peerId.toString()
      // Dedupe: one transport per peer. A reserved (null) slot also counts.
      if (record.transportsByPeer.has(key)) return
      // Reserve synchronously so a second peer-candidate in the same tick
      // (arrive + welcome) doesn't open a competing transport.
      record.transportsByPeer.set(key, null)
      // Increment synchronously so isConnecting() returns true
      // before the async handshake begins.
      this.#pendingTransports++
      void this.#startTransport(record, peerId, key)
    }
    record.onPeerDisconnected = ({ peerId }: { peerId: PeerId }) => {
      const key = peerId.toString()
      const transport = record.transportsByPeer.get(key)
      if (transport) void transport.disconnect()
      // Drop the slot so a later reconnect can re-establish.
      record.transportsByPeer.delete(key)
    }
    this.#records.set(adapter, record)

    adapter.on("peer-candidate", record.onPeerCandidate)
    adapter.on("peer-disconnected", record.onPeerDisconnected)
    void this.#watchAdapter(record)
    adapter.connect(this.#localPeerId)
  }

  /**
   * Stop managing `adapter`: unsubscribe its listeners, mark its watch loop to
   * exit, and disconnect any transports it established. Does not disconnect the
   * adapter itself — the owner controls the adapter (and underlying port)
   * lifecycle.
   */
  removeAdapter(adapter: NetworkAdapterInterface) {
    const record = this.#records.get(adapter)
    if (!record) return
    record.removed = true
    adapter.off("peer-candidate", record.onPeerCandidate)
    adapter.off("peer-disconnected", record.onPeerDisconnected)
    for (const transport of record.transportsByPeer.values()) {
      if (transport) void transport.disconnect()
    }
    record.transportsByPeer.clear()
    this.#records.delete(adapter)
    this.#generation++
    this.#onChangeCallback?.()
  }

  async #watchAdapter(record: AdapterRecord) {
    for await (const _nextState of record.adapter.state().watch()) {
      if (record.removed || this.#isShutdown) return
      this.#generation++
      this.#onChangeCallback?.()
    }
  }

  async #startTransport(record: AdapterRecord, peerId: PeerId, key: string) {
    let transport: NetworkAdapterTransport | undefined
    try {
      const subduction = await this.#subduction
      // The adapter may have been removed, or the peer disconnected (which
      // drops the reservation), while we awaited the wasm module.
      if (record.removed || this.#isShutdown) return
      if (!record.transportsByPeer.has(key)) return
      transport = new NetworkAdapterTransport(
        record.adapter,
        this.#localPeerId,
        peerId
      )
      record.transportsByPeer.set(key, transport)
      if (record.role === "accept") {
        await subduction.acceptTransport(transport, record.serviceName)
      } else {
        await subduction.connectTransport(transport, record.serviceName)
      }
    } catch {
      // Transport connection failed (e.g. peer disconnected during handshake).
      if (transport) void transport.disconnect()
      // Only clear our own slot — a reconnect may have replaced it.
      if (record.transportsByPeer.get(key) === transport) {
        record.transportsByPeer.delete(key)
      }
    } finally {
      this.#pendingTransports--
      this.#generation++
      this.#onChangeCallback?.()
    }
  }
}
