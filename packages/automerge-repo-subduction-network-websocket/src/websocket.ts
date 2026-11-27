import type * as N from "@automerge/subduction/slim"

/** Own the socket so cancellation also interrupts the native handshake:
 * aborting closes it, failing any pending receive. */
export async function openTransport(
  url: URL,
  signal: AbortSignal,
  onDisconnect: (cause: unknown) => void
): Promise<N.Transport> {
  signal.throwIfAborted()
  const socket = new WebSocket(url)
  socket.binaryType = "arraybuffer"
  const frames: Uint8Array[] = []
  const receivers: {
    resolve(bytes: Uint8Array): void
    reject(cause: unknown): void
  }[] = []
  const callbacks = new Set<() => void>()
  let ended = false
  let failure: unknown
  let resolveOpen!: () => void
  let rejectOpen!: (cause: unknown) => void
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })
  const finish = (cause: unknown) => {
    if (ended) return
    ended = true
    failure = cause
    signal.removeEventListener("abort", abort)
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
    socket.close()
    frames.length = 0
    rejectOpen(cause)
    for (const receiver of receivers.splice(0)) receiver.reject(cause)
    onDisconnect(cause)
    for (const callback of callbacks) callback()
    callbacks.clear()
  }
  const abort = () => finish(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  socket.onopen = resolveOpen
  socket.onclose = () => finish(new Error("Subduction WebSocket closed"))
  socket.onerror = () => finish(new Error("Subduction WebSocket failed"))
  socket.onmessage = event => {
    if (!(event.data instanceof ArrayBuffer)) {
      finish(new Error("Expected a binary Subduction WebSocket frame"))
      return
    }
    const bytes = new Uint8Array(event.data)
    const receiver = receivers.shift()
    if (receiver) receiver.resolve(bytes)
    else frames.push(bytes)
  }
  const transport: N.Transport = {
    async sendBytes(bytes) {
      if (ended) throw failure
      socket.send(new Uint8Array(bytes))
    },
    async recvBytes() {
      if (ended) throw failure
      const frame = frames.shift()
      if (frame) return frame
      return new Promise((resolve, reject) =>
        receivers.push({ resolve, reject })
      )
    },
    async disconnect() {
      finish(new Error("Subduction transport disconnected"))
    },
    onDisconnect(callback) {
      if (ended) callback()
      else callbacks.add(callback)
    },
  }
  try {
    await opened
    return transport
  } catch (cause) {
    finish(cause)
    throw cause
  }
}
