import { beelay } from "@automerge/automerge/slim"
import WebSocket from "isomorphic-ws"
import { WebSocketServer } from "ws"

export function connectClientWebsocket(
  beelay: beelay.Beelay,
  url: string,
  options: {
    initialBackoffMs?: number // Initial delay before first reconnect attempt
    maxBackoffMs?: number // Maximum delay between reconnect attempts
    backoffFactor?: number // Multiplicative factor for exponential backoff
    maxAttempts?: number // Maximum number of reconnection attempts (0 = unlimited)
    onStatusChange?: (
      status: "connecting" | "connected" | "disconnected" | "reconnecting"
    ) => void
  } = {}
) {
  const {
    initialBackoffMs = 1000,
    maxBackoffMs = 30000,
    backoffFactor = 1.5,
    maxAttempts = 0, // 0 means unlimited attempts
    onStatusChange = () => {},
  } = options

  let currentBackoff = initialBackoffMs
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let currentSocket: WebSocket | null = null
  let currentStream: ReturnType<typeof beelay.createStream> | null = null
  let isDisconnecting = false // Flag for intentional disconnection

  const connect = () => {
    if (currentSocket || beelay.isStopped()) return

    isDisconnecting = false
    const status = attempts === 0 ? "connecting" : "reconnecting"
    onStatusChange(status)

    const hostname = new URL(url).hostname
    let ws
    try {
      ws = new WebSocket(url)
    } catch (error) {
      console.error("beelay: WebSocket connection failed", error)
      // We get no information about this error, but it is almost always a network error,
      // so we schedule a reconnect
      scheduleReconnect()
      return
    }
    ws.binaryType = "arraybuffer"

    ws.onopen = () => {
      currentBackoff = initialBackoffMs // Reset backoff on successful connection
      attempts = 0

      onStatusChange("connected")
      console.log("beelay: WebSocket connection opened")

      const stream = beelay.createStream({
        direction: "connecting",
        remoteAudience: {
          type: "serviceName",
          serviceName: hostname,
        },
      })
      currentStream = stream

      stream.on("message", message => {
        console.log("beelay: sending outbound message")
        ws.send(toArrayBuffer(message))
      })

      ws.onmessage = event => {
        console.log("beelay: receiving message")
        stream.recv(new Uint8Array(event.data as Uint8Array))
      }

      stream.on("disconnect", () => {
        console.log("beelay: disconnecting")
        isDisconnecting = true // Mark as intentional disconnect
        ws.close()
      })

      ws.onclose = () => {
        console.log("beelay: WebSocket connection closed")
        stream.disconnect()
        currentSocket = null
        currentStream = null

        if (!isDisconnecting) {
          console.log("reconnecting")
          scheduleReconnect()
        } else {
          console.log("not reconnecting")
          onStatusChange("disconnected")
        }
      }

      ws.onerror = error => {
        console.error("beelay: WebSocket error:", error)
        // The connection will also trigger onclose, so we don't need to handle reconnection here
      }
    }

    // Here the onopen hasn't fired yet so we have to handle reconnect
    ws.onerror = error => {
      console.error("beelay: WebSocket error:", error)
      scheduleReconnect()
    }
  }

  const scheduleReconnect = () => {
    if (reconnectTimer || isDisconnecting || beelay.isStopped()) return

    // Check if we've hit max attempts
    if (maxAttempts > 0 && attempts >= maxAttempts) {
      onStatusChange("disconnected")
      console.log(`beelay: Giving up after ${attempts} reconnection attempts`)
      return
    }

    attempts++

    // Add some randomness to avoid thundering herd
    const jitter = Math.random() * 0.3 + 0.85 // between 0.85 and 1.15
    const delay = Math.min(currentBackoff * jitter, maxBackoffMs)

    console.log(
      `beelay: Scheduling reconnect in ${Math.round(
        delay
      )}ms (attempt ${attempts})`
    )
    onStatusChange("reconnecting")

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      currentBackoff = Math.min(currentBackoff * backoffFactor, maxBackoffMs)
      connect()
    }, delay)
  }

  const disconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    isDisconnecting = true

    if (currentStream) {
      currentStream.disconnect()
    }

    if (currentSocket && currentSocket.readyState < WebSocket.CLOSING) {
      currentSocket.close()
    }

    currentSocket = null
    currentStream = null
    onStatusChange("disconnected")
  }

  // Initial connection
  connect()

  // Return control functions
  return {
    disconnect,
    reconnect: () => {
      disconnect()
      isDisconnecting = false
      attempts = 0
      currentBackoff = initialBackoffMs
      connect()
    },
    getState: () => ({
      isConnected: !!(
        currentSocket && currentSocket.readyState === WebSocket.OPEN
      ),
      isConnecting: !!(
        currentSocket && currentSocket.readyState === WebSocket.CONNECTING
      ),
      reconnectAttempt: attempts,
    }),
  }
}

export function acceptWebsocket(
  beelay: beelay.Beelay,
  hostname: string,
  server: WebSocketServer
) {
  server.on("connection", socket => {
    const stream = beelay.createStream({
      direction: "accepting",
      receiveAudience: hostname,
    })
    stream.on("message", message => {
      socket.send(toArrayBuffer(message))
    })
    socket.on("message", message => {
      stream.recv(new Uint8Array(message as Uint8Array))
    })
    stream.on("disconnect", () => {
      socket.close()
    })
    socket.on("close", () => {
      stream.disconnect()
    })
  })
}

export const toArrayBuffer = (bytes: Uint8Array) => {
  const { buffer, byteOffset, byteLength } = bytes
  return buffer.slice(byteOffset, byteOffset + byteLength)
}
