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

    while (true) {
      this.#setConnectionState(url, "connecting")
      console.log(`[subduction] connecting to ${url}...`)

      try {
        const transport = await WebSocketTransport.connect(url)
        const subduction = await this.#subduction
        await subduction.connectTransport(transport, serviceName)
        this.#setConnectionState(url, "running")
        console.log(`[subduction] connected to ${url}`)
        backoff = RECONNECT_BASE_MS

        await transport.closed()
        console.log(`[subduction] disconnected from ${url}`)
      } catch (e) {
        console.warn(`[subduction] connection to ${url} failed:`, e)
      }

      this.#setConnectionState(url, "awaiting-reconnect")
      console.log(`[subduction] reconnecting to ${url} in ${backoff}ms`)
      await new Promise(r => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
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
