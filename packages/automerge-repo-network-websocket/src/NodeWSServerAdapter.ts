import * as CBOR from "cbor-x"
import { WebSocket, type WebSocketServer } from "isomorphic-ws"

import debug from "debug"
const log = debug("WebsocketServer")

import { Message, NetworkAdapter, PeerId } from "@automerge/automerge-repo"
import { FromClientMessage, FromServerMessage } from "./messages"

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
    })
  }

  join() {
    // throw new Error("The server doesn't join channels.")
  }

  leave() {
    // throw new Error("The server doesn't join channels.")
  }

  private transmit(targetId: PeerId, message: FromServerMessage) {
    if (this.sockets[targetId] === undefined) {
      log(`Tried to send message to disconnected peer: ${targetId}`)
      return
    }

    const encoded = CBOR.encode(message)
    // This incantation deals with websocket sending the whole
    // underlying buffer even if we just have a uint8array view on it
    const arrayBuf = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    )

    this.sockets[targetId]?.send(arrayBuf)
  }

  send(message: Message) {
    if (message.data.byteLength === 0) {
      throw new Error("tried to send a zero-length message")
    }
    const senderId = this.peerId
    if (!senderId) {
      throw new Error("No peerId set for the websocket server network adapter.")
    }

    this.transmit(message.targetId, message)
  }

  receiveMessage(message: Uint8Array, socket: WebSocket) {
    const cbor: FromClientMessage = CBOR.decode(message)

    const { type, senderId } = cbor

    const myPeerId = this.peerId
    if (!myPeerId) {
      throw new Error("Missing my peer ID.")
    }
    // log(
    //   `[${senderId}->${myPeerId}@${channelId}] ${type} | ${message.byteLength} bytes`
    // )
    switch (type) {
      case "join":
        // Let the rest of the system know that we have a new connection.
        this.emit("peer-candidate", { peerId: senderId })
        this.sockets[senderId] = socket

        // In this client-server connection, there's only ever one peer: us!
        // (and we pretend to be joined to every channel)
        this.transmit(senderId, { type: "peer", senderId: this.peerId! })
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
