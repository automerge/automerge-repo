import WebSocket from "ws"
import type { Transport } from "@automerge/automerge-subduction/slim"
import debug from "debug"

const log = debug("automerge-repo:subduction:ws-transport")

/**
 * Wraps a `ws` WebSocket connection as a subduction {@link Transport}.
 *
 * This lets us use `connectTransport`/`acceptTransport` over WebSocket
 * without relying on the browser's `WebSocket` global (`web_sys::WebSocket`).
 */
export class WebSocketTransport implements Transport {
  #ws: WebSocket
  #messageQueue: Uint8Array[] = []
  #waiters: Array<(msg: Uint8Array) => void> = []
  #errorWaiters: Array<(err: Error) => void> = []
  #isClosed = false
  #closedResolve!: () => void
  #closedPromise: Promise<void>
  #disconnectCallback: (() => void) | null = null

  constructor(ws: WebSocket) {
    this.#ws = ws
    this.#closedPromise = new Promise(r => {
      this.#closedResolve = r
    })
    ws.binaryType = "nodebuffer"
    ws.on("message", (data: Buffer) => {
      const bytes = new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength
      )
      const waiter = this.#waiters.shift()
      if (waiter) {
        this.#errorWaiters.shift()
        waiter(bytes)
      } else {
        this.#messageQueue.push(bytes)
      }
    })
    ws.on("close", () => {
      this.#isClosed = true
      this.#closedResolve()
      const err = new Error("WebSocket closed")
      for (const ew of this.#errorWaiters) ew(err)
      this.#errorWaiters = []
      this.#waiters = []
    })
    ws.on("error", (err: Error) => {
      log("ws error: %O", err)
      this.#isClosed = true
      this.#closedResolve()
      for (const ew of this.#errorWaiters) ew(err)
      this.#errorWaiters = []
      this.#waiters = []
    })
  }

  onDisconnect(callback: () => void): void {
    this.#disconnectCallback = callback
  }

  /**
   * Open a WebSocket connection and return a transport wrapping it.
   * Resolves once the connection is open.
   */
  static connect(url: string): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.once("open", () => resolve(new WebSocketTransport(ws)))
      ws.once("error", reject)
    })
  }

  async sendBytes(bytes: Uint8Array): Promise<void> {
    if (this.#isClosed) throw new Error("WebSocket closed")
    this.#ws.send(bytes)
  }

  recvBytes(): Promise<Uint8Array> {
    const queued = this.#messageQueue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.#isClosed) return Promise.reject(new Error("WebSocket closed"))
    return new Promise<Uint8Array>((resolve, reject) => {
      this.#waiters.push(resolve)
      this.#errorWaiters.push(reject)
    })
  }

  async disconnect(): Promise<void> {
    this.#teardown({ fireDisconnectCallback: false })
  }

  /** Resolves when the underlying WebSocket closes (for any reason). */
  closed(): Promise<void> {
    return this.#closedPromise
  }

  #teardown({
    fireDisconnectCallback,
  }: { fireDisconnectCallback?: boolean } = {}) {
    this.#isClosed = true
    this.#closedResolve()
    this.#ws.close()
    if (fireDisconnectCallback && this.#disconnectCallback)
      this.#disconnectCallback()
  }
}
