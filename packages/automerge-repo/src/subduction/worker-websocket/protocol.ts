/**
 * Wire protocol between {@link WorkerWebSocketTransport} (main thread) and
 * the socket host running inside a Worker.
 *
 * The worker is a dumb socket proxy: it owns `WebSocket` instances and
 * shuttles raw bytes back and forth. It never parses Subduction frames.
 * One port can host many sockets, keyed by `connId`.
 *
 * All payloads cross the boundary as transferred `ArrayBuffer`s (zero-copy).
 * Every message carries a `channel` tag so the protocol can coexist with
 * other traffic on a shared port (e.g. a `SharedWorker` doing double duty).
 *
 * ## Receive flow control (`ws-ack`)
 *
 * The receive path is credit-windowed so a busy main thread can't accumulate
 * an unbounded task-queue backlog: the host forwards at most `windowFrames`
 * unacknowledged `ws-bytes` frames; the transport acks in batches as the
 * consumer actually reads them (`recvBytes`). Overflow buffers in the worker
 * — where it is counted and capped (`maxBufferedBytes`) — and, crucially,
 * **socket reads are never paused**: the browser's internal WebSocket flow
 * control must never engage, or in-band protocol pings would stop being
 * answered and the server would stall on a closed TCP window.
 */

/** Default max un-acked frames delivered to the main thread. */
export const DEFAULT_WINDOW_FRAMES = 128

/**
 * Default cap on bytes buffered in the worker while the main thread lags.
 * Deliberately generous — sync bursts can move a lot of data — but finite:
 * exceeding it closes the socket with a distinct error (reconnect + resync
 * recover), which beats silent unbounded memory growth.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 128 * 1024 * 1024

/** Discriminator so proxy frames coexist with other port traffic. */
export const WS_PROXY_CHANNEL = "subduction-ws-proxy"

/** Messages sent from the main thread to the worker. */
export type WsProxyRequest =
  | {
      channel: typeof WS_PROXY_CHANNEL
      type: "ws-connect"
      connId: string
      url: string
      /** Max un-acked frames in flight to the main thread. */
      windowFrames?: number
      /** Max bytes buffered worker-side before fail-fast close. */
      maxBufferedBytes?: number
    }
  | {
      channel: typeof WS_PROXY_CHANNEL
      type: "ws-send"
      connId: string
      buf: ArrayBuffer
    }
  | {
      channel: typeof WS_PROXY_CHANNEL
      type: "ws-ack"
      connId: string
      /** Number of frames the consumer has read since the last ack. */
      count: number
    }
  | { channel: typeof WS_PROXY_CHANNEL; type: "ws-close"; connId: string }

/** Messages sent from the worker back to the main thread. */
export type WsProxyResponse =
  | { channel: typeof WS_PROXY_CHANNEL; type: "ws-open"; connId: string }
  | {
      channel: typeof WS_PROXY_CHANNEL
      type: "ws-bytes"
      connId: string
      buf: ArrayBuffer
    }
  | {
      channel: typeof WS_PROXY_CHANNEL
      type: "ws-error"
      connId: string
      message: string
    }
  | { channel: typeof WS_PROXY_CHANNEL; type: "ws-closed"; connId: string }

/**
 * The subset of the `Worker` / `MessagePort` API both sides rely on.
 *
 * Satisfied by a dedicated `Worker`, a `SharedWorker`'s `port`, a
 * `MessagePort` (browser and Node ≥15), and — on the worker side — the
 * worker's own global scope (`self`).
 */
export interface WorkerPortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void
  /** `MessagePort` requires `start()` before events flow; `Worker` has none. */
  start?(): void
}

/** Type guard for inbound frames on a possibly-shared port. */
export const isWsProxyMessage = (
  data: unknown
): data is WsProxyRequest | WsProxyResponse =>
  typeof data === "object" &&
  data !== null &&
  (data as { channel?: unknown }).channel === WS_PROXY_CHANNEL
