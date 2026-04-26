import debug from "debug"
import {
  Subduction,
  type Transport,
} from "@automerge/automerge-subduction/slim"
import { ConnectionManager } from "./ConnectionManager.js"

/**
 * Manages subduction connections backed by transports that the caller has
 * already established. Sibling of {@link SubductionConnections} (which opens
 * its own WebSockets) and {@link AdapterConnections} (which tunnels through
 * a NetworkAdapter).
 *
 * Use this when an upstream layer owns the underlying transport, e.g., a
 * frame demuxer that splits one WebSocket into a subduction Transport plus
 * a separate channel for another protocol. The transport's lifetime
 * belongs to the caller. This class does not reconnect on close.
 */
export class InjectedTransportConnections implements ConnectionManager {
  #subduction: Promise<Subduction>
  #log: debug.Debugger = debug("automerge-repo:subduction:injected")
  #onChangeCallback: (() => void) | null = null
  #pendingTransports = 0
  #generation = 0
  #isShutdown = false

  constructor(subduction: Promise<Subduction>) {
    this.#subduction = subduction
  }

  isConnecting(): boolean {
    return this.#pendingTransports > 0
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

  addTransport(
    transport: Transport,
    serviceName: string,
    onConnected?: () => void,
  ) {
    if (this.#isShutdown) return
    this.#pendingTransports++
    void this.#startTransport(transport, serviceName, onConnected)
    transport.onDisconnect(() => {
      this.#generation++
      this.#onChangeCallback?.()
    })
  }

  async #startTransport(
    transport: Transport,
    serviceName: string,
    onConnected?: () => void,
  ) {
    let connected = false
    try {
      const subduction = await this.#subduction
      await subduction.connectTransport(transport, serviceName)
      connected = true
      this.#log(`connected injected transport for ${serviceName}`)
    } catch (e) {
      console.warn(
        `[subduction] injected transport for ${serviceName} failed:`,
        e
      )
    } finally {
      this.#pendingTransports--
      this.#generation++
      this.#onChangeCallback?.()
    }
    if (connected && onConnected) {
      try {
        onConnected()
      } catch (e) {
        console.warn(
          `[subduction] onConnected callback for ${serviceName} threw:`,
          e
        )
      }
    }
  }
}
