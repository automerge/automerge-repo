import { WebSocket, type WebSocketServer } from "isomorphic-ws"

import debug from "debug"
const log = debug("WebsocketServer")

import {
  cbor as cborHelpers,
  NetworkAdapter,
  type PeerId,
} from "@automerge/automerge-repo"
import { FromClientMessage, FromServerMessage } from "./messages.js"
import { ProtocolV1, ProtocolVersion } from "./protocolVersion.js"

const { encode, decode } = cborHelpers

export class NodeWSServerAdapter extends NetworkAdapter {
  server: WebSocketServer
  sockets: { [peerId: PeerId]: WebSocket } = {}

  constructor(server: WebSocketServer) {
    super()
    this.server = server
  }

  connect(peerId: PeerId) {
    this.peerId = peerId
    this.server.on("connection", socket => {
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
      this.emit("ready", { network: this })
    })
  }

  disconnect() {
    // throw new Error("The server doesn't join channels.")
  }

  send(message: FromServerMessage) {
    if ("data" in message && message.data.byteLength === 0) {
      throw new Error("tried to send a zero-length message")
    }
    const senderId = this.peerId
    if (!senderId) {
      throw new Error("No peerId set for the websocket server network adapter.")
    }

    if (this.sockets[message.targetId] === undefined) {
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

  receiveMessage(message: Uint8Array, socket: WebSocket) {
    const cbor: FromClientMessage = decode(message)

    const { type, senderId } = cbor

    const myPeerId = this.peerId
    if (!myPeerId) {
      throw new Error("Missing my peer ID.")
    }
    log(
      `[${senderId}->${myPeerId}${
        "documentId" in cbor ? "@" + cbor.documentId : ""
      }] ${type} | ${message.byteLength} bytes`
    )
    switch (type) {
      case "join":
        // Let the rest of the system know that we have a new connection.
        this.emit("peer-candidate", { peerId: senderId })
        this.sockets[senderId] = socket

        // In this client-server connection, there's only ever one peer: us!
        // (and we pretend to be joined to every channel)
        const selectedProtocolVersion = selectProtocol(
          cbor.supportedProtocolVersions
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
        break
      case "leave":
        // It doesn't seem like this gets called;
        // we handle leaving in the socket close logic
        // TODO: confirm this
        // ?
        break

      default:
        this.emit("message", cbor)
        break
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
