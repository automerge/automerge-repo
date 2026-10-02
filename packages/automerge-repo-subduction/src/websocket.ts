import * as N from "@automerge/subduction/slim"

/** Own the socket so cancellation also interrupts the native handshake. */
export async function openTransport(
  url: URL,
  signer: N.Signer,
  serviceName: string,
  signal: AbortSignal,
  onDisconnect: (cause: unknown) => void
): Promise<N.AuthenticatedTransport> {
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
    const verifyingKey = signer.verifyingKey()
    if (!(verifyingKey instanceof Uint8Array) || verifyingKey.length !== 32)
      throw new TypeError("Signer public key must contain 32 bytes")
    // Native's signer is infallible (a rejected sign promise panics WASM). After
    // closing the socket, an inert signature lets it reach the transport error.
    // No such signature can be sent; the provider's pending I/O may continue.
    const cancellableSigner: N.Signer = {
      verifyingKey() {
        return verifyingKey
      },
      sign(message) {
        if (ended) return new Uint8Array(64)
        return new Promise<Uint8Array>(resolve => {
          const settle = (signature: Uint8Array) => {
            signal.removeEventListener("abort", cancel)
            callbacks.delete(cancel)
            resolve(signature)
          }
          const cancel = () => settle(new Uint8Array(64))
          signal.addEventListener("abort", cancel, { once: true })
          callbacks.add(cancel)
          Promise.resolve()
            .then(() => {
              if (ended) return new Uint8Array(64)
              return signer.sign(message)
            })
            .then(
              signature => {
                if (
                  !(signature instanceof Uint8Array) ||
                  signature.length !== 64
                ) {
                  finish(
                    new TypeError("Signer signature must contain 64 bytes")
                  )
                  settle(new Uint8Array(64))
                } else settle(signature)
              },
              cause => {
                finish(cause)
                settle(new Uint8Array(64))
              }
            )
        })
      },
    }
    return await N.AuthenticatedTransport.setupDiscover(
      transport,
      cancellableSigner,
      serviceName
    )
  } catch (cause) {
    finish(cause)
    throw cause
  }
}
