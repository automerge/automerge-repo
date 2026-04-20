import WebSocket from "isomorphic-ws"
import type { Transport } from "@automerge/automerge-subduction/slim"
import debug from "debug"

const log = debug("automerge-repo:subduction:ws-transport")

/**
 * Wraps a WebSocket connection as a subduction {@link Transport}.
 *
 * Works in both Node.js (via `ws`) and the browser (via native `WebSocket`)
 * through `isomorphic-ws`.
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
    ws.binaryType = "arraybuffer"

    ws.addEventListener("message", (event: WebSocket.MessageEvent) => {
      const raw = event.data
      const bytes =
        raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : new Uint8Array(
              (raw as Buffer).buffer,
              (raw as Buffer).byteOffset,
              (raw as Buffer).byteLength
            )
      const waiter = this.#waiters.shift()
      if (waiter) {
        this.#errorWaiters.shift()
        waiter(bytes)
      } else {
        this.#messageQueue.push(bytes)
      }
    })

    ws.addEventListener("close", () => {
      this.#isClosed = true
      this.#closedResolve()
      const err = new Error("WebSocket closed")
      for (const ew of this.#errorWaiters) ew(err)
      this.#errorWaiters = []
      this.#waiters = []
    })

    ws.addEventListener("error", (event: WebSocket.ErrorEvent) => {
      log("ws error: %O", event)
      this.#isClosed = true
      this.#closedResolve()
      const err =
        "error" in event && event.error instanceof Error
          ? event.error
          : new Error("WebSocket error")
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
      const onOpen = () => {
        ws.removeEventListener("open", onOpen)
        ws.removeEventListener("error", onError)
        resolve(new WebSocketTransport(ws))
      }
      const onError = (event: WebSocket.ErrorEvent) => {
        ws.removeEventListener("open", onOpen)
        ws.removeEventListener("error", onError)
        const err =
          "error" in event && event.error instanceof Error
            ? event.error
            : new Error("WebSocket connection failed")
        reject(err)
      }
      ws.addEventListener("open", onOpen)
      ws.addEventListener("error", onError)
    })
  }

  async sendBytes(bytes: Uint8Array): Promise<void> {
    if (this.#isClosed) throw new Error("WebSocket closed")
    this.#ws.send(bytes.slice())
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
