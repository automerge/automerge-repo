import {
  cbor as cborHelpers,
  isValidRepoMessage,
  NetworkAdapter,
  type PeerId,
} from "@automerge/automerge-repo"
import assert from "assert"
import debug from "debug"
import WebSocket, { type WebSocketServer } from "isomorphic-ws"
import {
  FromClientMessage,
  FromServerMessage,
  isJoinMessage,
  isLeaveMessage,
} from "./messages.js"
import { ProtocolV1, ProtocolVersion } from "./protocolVersion.js"

const log = debug("automerge-repo:websocket:server")

const { encode, decode } = cborHelpers

interface WebSocketWithIsAlive extends WebSocket {
  isAlive: boolean
}

export class NodeWSServerAdapter extends NetworkAdapter {
  server: WebSocketServer
  sockets: { [peerId: PeerId]: WebSocket } = {}

  constructor(server: WebSocketServer) {
    super()
    this.server = server
  }

  connect(peerId: PeerId) {
    this.peerId = peerId

    this.server.on("close", function close() {
      clearInterval(interval)
    })

    this.server.on("connection", (socket: WebSocketWithIsAlive) => {
      // When a socket closes, or disconnects, remove it from our list
      socket.on("close", () => {
        for (const [otherPeerId, otherSocket] of Object.entries(this.sockets)) {
          if (socket === otherSocket) {
            this.emit("peer-disconnected", { peerId: otherPeerId as PeerId })
            delete this.sockets[otherPeerId as PeerId]
          }
        }
      })

      socket.on("message", message =>
        this.receiveMessage(message as Uint8Array, socket)
      )

      // Start out "alive", and every time we get a pong, reset that state.
      socket.isAlive = true
      socket.on("pong", () => (socket.isAlive = true))

      this.emit("ready", { network: this })
    })

    // Every interval, terminate connections to lost clients,
    // then mark all clients as potentially dead and then ping them.
    const interval = setInterval(() => {
      ;(this.server.clients as Set<WebSocketWithIsAlive>).forEach(socket => {
        if (socket.isAlive === false) {
          // Make sure we clean up this socket even though we're terminating.
          // This might be unnecessary but I have read reports of the close() not happening for 30s.
          for (const [otherPeerId, otherSocket] of Object.entries(
            this.sockets
          )) {
            if (socket === otherSocket) {
              this.emit("peer-disconnected", { peerId: otherPeerId as PeerId })
              delete this.sockets[otherPeerId as PeerId]
            }
          }
          return socket.terminate()
        }
        socket.isAlive = false
        socket.ping()
      })
    }, 5000)
  }

  disconnect() {
    // throw new Error("The server doesn't join channels.")
  }

  send(message: FromServerMessage) {
    assert("targetId" in message && message.targetId !== undefined)

    if (
      isValidRepoMessage(message) &&
      "data" in message &&
      message.data.byteLength === 0
    ) {
      throw new Error("tried to send a zero-length message")
    }

    const senderId = this.peerId
    if (!senderId) {
      throw new Error("No peerId set for the websocket server network adapter.")
    }

    if (
      isValidRepoMessage(message) &&
      this.sockets[message.targetId] === undefined
    ) {
      log(`Tried to send message to disconnected peer: ${message.targetId}`)
      return
    }

    const encoded = encode(message)
    // This incantation deals with websocket sending the whole
    // underlying buffer even if we just have a uint8array view on it
    const arrayBuf = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    )

    this.sockets[message.targetId]?.send(arrayBuf)
  }

  receiveMessage(messageBytes: Uint8Array, socket: WebSocket) {
    const message: FromClientMessage = decode(messageBytes)

    const { type, senderId } = message

    const myPeerId = this.peerId
    if (!myPeerId) throw new Error("Missing my peer ID.")

    const documentId = "documentId" in message ? "@" + message.documentId : ""
    const { byteLength } = messageBytes
    log(`[${senderId}->${myPeerId}${documentId}] ${type} | ${byteLength} bytes`)

    if (isJoinMessage(message)) {
      const existingSocket = this.sockets[senderId]
      if (existingSocket) {
        if (existingSocket.readyState === WebSocket.OPEN) {
          existingSocket.close()
        }
        this.emit("peer-disconnected", { peerId: senderId })
      }

      // Let the rest of the system know that we have a new connection.
      this.emit("peer-candidate", { peerId: senderId })
      this.sockets[senderId] = socket

      // In this client-server connection, there's only ever one peer: us!
      // (and we pretend to be joined to every channel)
      const selectedProtocolVersion = selectProtocol(
        message.supportedProtocolVersions
      )
      if (selectedProtocolVersion === null) {
        this.send({
          type: "error",
          senderId: this.peerId!,
          message: "unsupported protocol version",
          targetId: senderId,
        })
        this.sockets[senderId].close()
        delete this.sockets[senderId]
      } else {
        this.send({
          type: "peer",
          senderId: this.peerId!,
          selectedProtocolVersion: ProtocolV1,
          targetId: senderId,
        })
      }
    } else if (isLeaveMessage(message)) {
      // It doesn't seem like this gets called;
      // we handle leaving in the socket close logic
      // TODO: confirm this
      // ?
    } else {
      this.emit("message", message)
    }
  }
}

function selectProtocol(versions?: ProtocolVersion[]): ProtocolVersion | null {
  if (versions === undefined) {
    return ProtocolV1
  }
  if (versions.includes(ProtocolV1)) {
    return ProtocolV1
  }
  return null
}
