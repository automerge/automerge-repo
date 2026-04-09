import debug from "debug"
import { WebSocketTransport } from "./websocket-transport.js"
import { Subduction } from "@automerge/automerge-subduction/slim"
import { ConnectionManager } from "./ConnectionManager.js"

export type ConnectionState = "connecting" | "running" | "awaiting-reconnect"

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000

export class SubductionConnections implements ConnectionManager {
  #connectionStates = new Map<string, ConnectionState>()
  #log: debug.Debugger = debug("automerge-repo:subduction:connections")
  #subduction: Promise<Subduction>
  #onChangeCallback: (() => void) | null = null
  #generation = 0
  #isShutdown = false
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(subduction: Promise<Subduction>) {
    this.#subduction = subduction
  }

  // ── ConnectionManager interface ─────────────────────────────────────

  isConnecting(): boolean {
    for (const state of this.#connectionStates.values()) {
      if (state === "connecting") return true
    }
    return false
  }

  generation(): number {
    return this.#generation
  }

  onChange(callback: () => void): void {
    this.#onChangeCallback = callback
  }

  // ── Connection management ───────────────────────────────────────────

  async manageConnection(url: string) {
    const serviceName = new URL(url).host
    let backoff = RECONNECT_BASE_MS

    while (!this.#isShutdown) {
      this.#setConnectionState(url, "connecting")
      this.#log(`connecting to ${url}...`)

      try {
        const transport = await WebSocketTransport.connect(url)

        if (this.#isShutdown) {
          transport.disconnect()
          break
        }

        const subduction = await this.#subduction
        await subduction.connectTransport(transport, serviceName)
        this.#setConnectionState(url, "running")
        this.#log(`connected to ${url}`)
        backoff = RECONNECT_BASE_MS

        await transport.closed()
        this.#log(`disconnected from ${url}`)
      } catch (e) {
        console.warn(`[subduction] connection to ${url} failed:`, e)
      }

      if (this.#isShutdown) break

      this.#setConnectionState(url, "awaiting-reconnect")
      this.#log(`reconnecting to ${url} in ${backoff}ms`)
      await new Promise<void>(r => {
        this.#reconnectTimer = setTimeout(() => {
          this.#reconnectTimer = null
          r()
        }, backoff)
      })
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
    }
  }

  shutdown(): void {
    this.#isShutdown = true
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }

  #setConnectionState(url: string, state: ConnectionState) {
    const prev = this.#connectionStates.get(url)
    if (prev === state) return
    this.#connectionStates.set(url, state)
    this.#generation++
    this.#onChangeCallback?.()
  }
}
