import {
  NetworkAdapter,
  type PeerId,
  type PeerMetadata,
} from "@automerge/automerge-repo/slim"

import debug from "debug"

import {
  type FromClientMessage,
  type FromServerMessage,
  isErrorMessage,
  isPeerMessage,
} from "./messages.js"
import { ProtocolV1 } from "./protocolVersion.js"
import { WebSocketClientAdapter } from "./WebSocketClientAdapter.js"
import {
  WS_WORKER_RPC,
  type WsWorkerCommandBody,
  type WsWorkerEvent,
} from "./websocket-worker-rpc.js"

/**
 * A drop-in replacement for {@link WebSocketClientAdapter} that runs the socket
 * — and CBOR encode/decode — on a Worker, so socket I/O and keepalives keep
 * flowing even while the host thread is busy with synchronous CRDT/Wasm work.
 *
 * It has the **same API** as {@link WebSocketClientAdapter} (same constructor,
 * methods, and events), so it's a direct swap anywhere a `WebSocketClientAdapter`
 * is used — `network: [...]` or `subductionAdapters: [...]`:
 *
 * ```ts
 * const repo = new Repo({ network: [new WebSocketWorkerClientAdapter("wss://…")] })
 * ```
 *
 * If a Worker can't be spawned (Node, or some nested-worker contexts), it
 * transparently falls back to a main-thread {@link WebSocketClientAdapter}.
 */
export class WebSocketWorkerClientAdapter extends NetworkAdapter {
  #ready = false
  #readyResolver?: () => void
  #readyPromise: Promise<void> = new Promise(resolve => {
    this.#readyResolver = resolve
  })

  #worker?: Worker
  #fallback?: WebSocketClientAdapter
  #log = debug("automerge-repo:websocket:worker")

  /** This adapter only connects to one remote at a time. */
  remotePeerId?: PeerId

  /**
   * @param url - WebSocket URL to connect to.
   * @param retryInterval - Reconnect delay in ms (default 5000).
   * @param worker - Optional Worker to use instead of spawning one (mainly for
   *   testing).
   */
  constructor(
    public readonly url: string,
    public readonly retryInterval = 5000,
    worker?: Worker
  ) {
    super()
    this.#log = this.#log.extend(url)
    if (worker) {
      this.#worker = worker
      this.#worker.addEventListener("message", this.#onWorkerMessage)
      this.#worker.addEventListener("error", this.#onWorkerError)
    }
  }

  isReady() {
    return this.#fallback ? this.#fallback.isReady() : this.#ready
  }

  whenReady() {
    return this.#fallback ? this.#fallback.whenReady() : this.#readyPromise
  }

  #forceReady() {
    if (!this.#ready) {
      this.#ready = true
      this.#readyResolver?.()
    }
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata) {
    this.peerId = peerId
    this.peerMetadata = peerMetadata ?? {}

    if (!this.#worker && !this.#fallback) {
      if (typeof Worker === "undefined") {
        this.#useFallback()
      } else {
        try {
          this.#worker = new Worker(
            new URL("./websocket.worker.js", import.meta.url),
            { type: "module" }
          )
          this.#worker.addEventListener("message", this.#onWorkerMessage)
          this.#worker.addEventListener("error", this.#onWorkerError)
        } catch (err) {
          this.#log(
            "worker unavailable, falling back to a main-thread socket: %o",
            err
          )
          this.#useFallback()
        }
      }
    }

    if (this.#fallback) {
      this.#fallback.connect(peerId, peerMetadata)
      return
    }

    this.#post({
      type: "connect",
      url: this.url,
      retryInterval: this.retryInterval,
    })

    // Mark ready if we haven't received a peer ack within 1s — matches
    // WebSocketClientAdapter so we don't hold up marking docs unavailable.
    setTimeout(() => this.#forceReady(), 1000)
  }

  #useFallback() {
    const fallback = new WebSocketClientAdapter(this.url, this.retryInterval)
    this.#fallback = fallback
    fallback.on("message", message => this.emit("message", message))
    fallback.on("peer-candidate", payload =>
      this.emit("peer-candidate", payload)
    )
    fallback.on("peer-disconnected", payload =>
      this.emit("peer-disconnected", payload)
    )
    fallback.on("close", () => this.emit("close"))
  }

  #onWorkerMessage = (e: MessageEvent) => {
    const event = e.data as WsWorkerEvent
    if (!event || event.channel !== WS_WORKER_RPC) return
    switch (event.type) {
      case "open":
        this.#join()
        return
      case "message":
        this.#receiveMessage(event.message)
        return
      case "close":
        if (this.remotePeerId)
          this.emit("peer-disconnected", { peerId: this.remotePeerId })
        return
      case "error":
        this.#log("websocket error (in worker)")
        return
    }
  }

  #onWorkerError = (e: Event) => {
    this.#log("websocket worker error: %o", e)
  }

  #join() {
    if (!this.peerId) return
    this.#post({
      type: "send",
      message: {
        type: "join",
        senderId: this.peerId,
        peerMetadata: this.peerMetadata ?? {},
        supportedProtocolVersions: [ProtocolV1],
      },
    })
  }

  #receiveMessage(message: FromServerMessage) {
    if (isPeerMessage(message)) {
      this.#log(`peer: ${message.senderId}`)
      this.remotePeerId = message.senderId
      this.#forceReady()
      this.emit("peer-candidate", {
        peerId: message.senderId,
        peerMetadata: message.peerMetadata,
      })
    } else if (isErrorMessage(message)) {
      this.#log(`error: ${message.message}`)
    } else {
      this.emit("message", message)
    }
  }

  send(message: FromClientMessage) {
    if ("data" in message && message.data?.byteLength === 0)
      throw new Error("Tried to send a zero-length message")

    if (this.#fallback) {
      this.#fallback.send(message)
      return
    }
    if (!this.#worker) {
      this.#log("Tried to send on a disconnected adapter.")
      return
    }
    this.#post({ type: "send", message })
  }

  disconnect() {
    if (this.#fallback) {
      this.#fallback.disconnect()
      return
    }
    if (this.remotePeerId)
      this.emit("peer-disconnected", { peerId: this.remotePeerId })
    this.#post({ type: "disconnect" })
    if (this.#worker) {
      this.#worker.removeEventListener("message", this.#onWorkerMessage)
      this.#worker.removeEventListener("error", this.#onWorkerError)
      this.#worker.terminate()
      this.#worker = undefined
    }
  }

  #post(command: WsWorkerCommandBody) {
    this.#worker?.postMessage({ channel: WS_WORKER_RPC, ...command })
  }
}
