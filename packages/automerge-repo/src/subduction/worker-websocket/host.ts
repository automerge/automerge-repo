/**
 * Worker-side socket host for {@link WorkerWebSocketTransport}.
 *
 * Owns the actual `WebSocket` instances and proxies raw bytes to/from the
 * main thread over a message port. Factored out of the worker entry file so
 * it can be exercised in tests over a plain `MessageChannel` with an
 * injected socket implementation.
 *
 * ## Invariant: socket reads are never gated
 *
 * Hosting the socket in a worker only helps if the thread consuming
 * WebSocket events stays responsive: as long as `message` events are
 * drained promptly, the browser's internal receive flow control never
 * engages, in-band protocol pings keep being parsed (and ponged) by the
 * network process, and the server's TCP send window stays open.
 *
 * Therefore the receive credit window below only gates *delivery to the
 * main thread* — overflow buffers here in the worker, counted and capped.
 * No future change may pause, defer, or conditionally skip the socket
 * `message` handler.
 */

import {
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_WINDOW_FRAMES,
  WS_PROXY_CHANNEL,
  WS_PROXY_PROTOCOL_VERSION,
  isWsProxyMessage,
  wsProxyVersionMismatch,
  wsProxyVersionOk,
  type WorkerPortLike,
  type WsProxyRequest,
  type WsProxyResponse,
} from "./protocol.js"

/**
 * The subset of the browser `WebSocket` API the host relies on. Native
 * `WebSocket` (available in every worker context) satisfies it.
 */
export interface WebSocketLike {
  binaryType: string
  send(data: Uint8Array): void
  close(): void
  addEventListener(type: "open", listener: () => void): void
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void
  ): void
  addEventListener(type: "close", listener: () => void): void
  addEventListener(type: "error", listener: (event: unknown) => void): void
}

export interface WebSocketHostOptions {
  /** Socket factory; defaults to the context's native `WebSocket`. */
  createSocket?: (url: string) => WebSocketLike
}

/** Per-connection receive-window state. */
interface Conn {
  socket: WebSocketLike
  /** Frames posted to the main thread but not yet acked. */
  inFlight: number
  /** Frames received from the socket, awaiting window credit. */
  pending: ArrayBuffer[]
  /** Total bytes across `pending` (for the fail-fast cap). */
  pendingBytes: number
  windowFrames: number
  maxBufferedBytes: number
  /** Socket closed while frames were still pending delivery. */
  closedPendingFlush: boolean
  /**
   * Set on cap breach or `ws-close`. The socket's own event listeners
   * outlive the `conns` entry, so they need a flag to stop buffering
   * frames (and re-announcing the close) between `socket.close()` and
   * the close event actually firing.
   */
  dead: boolean
}

/**
 * Attach the socket host to a port. Returns a detach function that removes
 * the message listener and closes every socket the host still owns.
 */
export function attachWebSocketHost(
  port: WorkerPortLike,
  { createSocket }: WebSocketHostOptions = {}
): () => void {
  const makeSocket =
    createSocket ??
    ((url: string) =>
      new (
        globalThis as unknown as {
          WebSocket: new (url: string) => WebSocketLike
        }
      ).WebSocket(url))

  const conns = new Map<string, Conn>()

  const post = (msg: WsProxyResponse, transfer?: Transferable[]) => {
    port.postMessage({ v: WS_PROXY_PROTOCOL_VERSION, ...msg }, transfer)
  }

  const postBytes = (connId: string, buf: ArrayBuffer) => {
    post({ channel: WS_PROXY_CHANNEL, type: "ws-bytes", connId, buf }, [buf])
  }

  /** Forward as many pending frames as the window allows (in order). */
  const drain = (connId: string, conn: Conn) => {
    while (conn.inFlight < conn.windowFrames && conn.pending.length > 0) {
      const buf = conn.pending.shift()
      if (buf === undefined) break
      conn.pendingBytes -= buf.byteLength
      conn.inFlight++
      postBytes(connId, buf)
    }

    // The socket closed while we were still holding frames; now that the
    // last one has been delivered, complete the close.
    if (conn.closedPendingFlush && conn.pending.length === 0) {
      conns.delete(connId)
      post({ channel: WS_PROXY_CHANNEL, type: "ws-closed", connId })
    }
  }

  const handleConnect = (
    msg: Extract<WsProxyRequest, { type: "ws-connect" }>
  ) => {
    const { connId, url } = msg

    let socket: WebSocketLike
    try {
      socket = makeSocket(url)
    } catch (e) {
      post({
        channel: WS_PROXY_CHANNEL,
        type: "ws-error",
        connId,
        message:
          e instanceof Error ? e.message : "WebSocket construction failed",
      })
      return
    }

    socket.binaryType = "arraybuffer"
    const conn: Conn = {
      socket,
      inFlight: 0,
      pending: [],
      pendingBytes: 0,
      // A window below 1 could never forward anything; clamp.
      windowFrames: Math.max(1, msg.windowFrames ?? DEFAULT_WINDOW_FRAMES),
      maxBufferedBytes: msg.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      closedPendingFlush: false,
      dead: false,
    }
    conns.set(connId, conn)

    socket.addEventListener("open", () => {
      post({ channel: WS_PROXY_CHANNEL, type: "ws-open", connId })
    })

    // Invariant: this handler always runs to completion for every frame;
    // reads are never paused (see module docs). Only delivery is gated.
    socket.addEventListener("message", event => {
      if (conn.dead) return
      const raw = event.data
      // With binaryType="arraybuffer" binary frames arrive as ArrayBuffer;
      // ignore anything else (subduction frames are always binary).
      if (!(raw instanceof ArrayBuffer)) return

      // Fast path: window open and nothing queued; forward immediately.
      if (conn.inFlight < conn.windowFrames && conn.pending.length === 0) {
        conn.inFlight++
        postBytes(connId, raw)
        return
      }

      // The consumer is lagging: hold the frame here, where it can be
      // counted against the byte cap.
      conn.pending.push(raw)
      conn.pendingBytes += raw.byteLength

      if (conn.pendingBytes > conn.maxBufferedBytes) {
        // Fail fast rather than grow without bound. The reconnect loop and
        // subduction's resync recover; the error code makes the cause
        // diagnosable. Drop the backlog — resync re-fetches it.
        conn.dead = true
        conns.delete(connId)
        conn.pending = []
        conn.pendingBytes = 0
        socket.close()
        post({
          channel: WS_PROXY_CHANNEL,
          type: "ws-error",
          connId,
          message: `receive backlog exceeded maxBufferedBytes (${conn.maxBufferedBytes}); closing`,
          code: "backlog-exceeded",
        })
        post({ channel: WS_PROXY_CHANNEL, type: "ws-closed", connId })
      }
    })

    socket.addEventListener("error", event => {
      const message =
        typeof event === "object" &&
        event !== null &&
        "message" in event &&
        typeof (event as { message: unknown }).message === "string"
          ? (event as { message: string }).message
          : "WebSocket error"
      post({ channel: WS_PROXY_CHANNEL, type: "ws-error", connId, message })
    })

    socket.addEventListener("close", () => {
      const c = conns.get(connId)
      if (!c) return // already torn down (cap breach or ws-close)

      if (c.pending.length > 0) {
        // Frames the server actually sent must not be lost: deliver the
        // backlog (as acks free the window) before reporting the close.
        c.closedPendingFlush = true
      } else {
        conns.delete(connId)
        post({ channel: WS_PROXY_CHANNEL, type: "ws-closed", connId })
      }
    })
  }

  const handleMessage = (event: MessageEvent) => {
    if (!isWsProxyMessage(event.data)) return
    const msg = event.data as WsProxyRequest

    if (!wsProxyVersionOk(msg)) {
      // Deploy skew: this proxy build and the client build disagree. Fail
      // the connection loudly — the error surfaces through the transport's
      // normal error path with a machine-readable code.
      post({
        channel: WS_PROXY_CHANNEL,
        type: "ws-error",
        connId: (msg as { connId?: string }).connId ?? "unknown",
        message: wsProxyVersionMismatch(msg),
        code: "protocol-mismatch",
      })
      return
    }

    switch (msg.type) {
      case "ws-connect":
        handleConnect(msg)
        break

      case "ws-send": {
        const conn = conns.get(msg.connId)
        // Socket already gone: the close/error event is (or will be) on its
        // way to the main thread; dropping the frame mirrors a socket that
        // died mid-send.
        conn?.socket.send(new Uint8Array(msg.buf))
        break
      }

      case "ws-ack": {
        const conn = conns.get(msg.connId)
        if (!conn) break
        // Guard the arithmetic: a malformed count (NaN, negative, ∞)
        // would otherwise wedge or blow open the window permanently.
        if (!Number.isInteger(msg.count) || msg.count <= 0) break
        conn.inFlight = Math.max(0, conn.inFlight - msg.count)
        drain(msg.connId, conn)
        break
      }

      case "ws-close": {
        const conn = conns.get(msg.connId)
        conns.delete(msg.connId)
        if (conn) {
          conn.dead = true
          conn.socket.close()
        }
        break
      }
    }
  }

  const detach = () => {
    port.removeEventListener("message", handleMessage)
    port.removeEventListener("close", detach)
    for (const conn of conns.values()) conn.socket.close()
    conns.clear()
  }

  port.addEventListener("message", handleMessage)
  // MessagePort-only (a Worker global never fires it): the client context
  // died, so close its sockets — the server would otherwise keep a
  // phantom peer, and pushed frames would buffer here toward the byte cap
  // with no consumer.
  port.addEventListener("close", detach)
  port.start?.()

  return detach
}
