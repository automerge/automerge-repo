import debug from "debug"
import { WebSocketTransport } from "./websocket-transport.js"
import {
  PeerId as SubductionPeerId,
  Subduction,
} from "@automerge/automerge-subduction/slim"
import { ConnectionManager } from "./ConnectionManager.js"

export type ConnectionState = "connecting" | "running" | "awaiting-reconnect"

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000

/**
 * Invoked once per successful subduction handshake on a websocket
 * transport. `subductionPeerId` is the value returned by
 * `connectTransport`. The websocket path does not surface an
 * automerge-repo PeerId — see `SubductionSource` for the shared
 * `OnSubductionPeerBound` shape.
 */
export type OnWebSocketPeerBound = (binding: {
  subductionPeerId: SubductionPeerId
  url: string
}) => void

export class SubductionConnections implements ConnectionManager {
  #connectionStates = new Map<string, ConnectionState>()
  #log: debug.Debugger = debug("automerge-repo:subduction:connections")
  #subduction: Promise<Subduction>
  #onChangeCallback: (() => void) | null = null
  #onPeerBound: OnWebSocketPeerBound | null
  #generation = 0
  #isShutdown = false
  #pendingSleeps = new Map<ReturnType<typeof setTimeout>, () => void>()

  constructor(
    subduction: Promise<Subduction>,
    onPeerBound?: OnWebSocketPeerBound
  ) {
    this.#subduction = subduction
    this.#onPeerBound = onPeerBound ?? null
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
        const subductionPeerId = await subduction.connectTransport(
          transport,
          serviceName
        )
        this.#setConnectionState(url, "running")
        this.#log(`connected to ${url}`)
        backoff = RECONNECT_BASE_MS

        // Notify after the connection state has flipped to "running"
        // so consumers reading repo state from inside the listener see
        // the settled value. Throws from the listener must not abort
        // the reconnect loop or cancel the live transport.
        if (this.#onPeerBound !== null) {
          try {
            this.#onPeerBound({ subductionPeerId, url })
          } catch (e) {
            this.#log("onPeerBound threw for %s: %O", url, e)
          }
        }

        await transport.closed()
        this.#log(`disconnected from ${url}`)
      } catch (e) {
        console.warn(`[subduction] connection to ${url} failed:`, e)
      }

      if (this.#isShutdown) break

      this.#setConnectionState(url, "awaiting-reconnect")
      this.#log(`reconnecting to ${url} in ${backoff}ms`)
      await new Promise<void>(r => {
        const timer = setTimeout(() => {
          this.#pendingSleeps.delete(timer)
          r()
        }, backoff)
        this.#pendingSleeps.set(timer, r)
      })
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
    }
  }

  shutdown(): void {
    this.#isShutdown = true
    this.#onPeerBound = null
    for (const [timer, resolve] of this.#pendingSleeps) {
      clearTimeout(timer)
      resolve()
    }
    this.#pendingSleeps.clear()
  }

  #setConnectionState(url: string, state: ConnectionState) {
    const prev = this.#connectionStates.get(url)
    if (prev === state) return
    this.#connectionStates.set(url, state)
    this.#generation++
    this.#onChangeCallback?.()
  }
}
