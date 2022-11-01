import EventEmitter from "eventemitter3"
import * as ws from "isomorphic-ws"
import { type WebSocketServer, WebSocket } from "isomorphic-ws"
import * as CBOR from "cbor-x"

import debug from "debug"
const log = debug("WebsocketServer")

import {
  ChannelId,
  DecodedMessage,
  NetworkAdapter,
  NetworkAdapterEvents,
  PeerId,
} from "automerge-repo"

export class NodeWSServerAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements NetworkAdapter
{
  peerId?: PeerId
  server: WebSocketServer
  sockets: { [peerId: PeerId]: WebSocket } = {}

  constructor(server: WebSocketServer) {
    super()
    this.server = server
  }

  connect(peerId: PeerId) {
    this.peerId = peerId
    this.server.on("connection", (socket) => {
      // When a socket closes, or disconnects, remove it from the array.
      // TODO
      //      socket.on("close", () => {
      //        this.sockets = this.sockets.filter((s) => s !== socket)
      //})

      socket.on("message", (message) =>
        this.receiveMessage(message as Uint8Array, socket)
      )
    })
  }

  join(docId: ChannelId) {
    // throw new Error("The server doesn't join channels.")
  }

  leave(docId: ChannelId) {
    // throw new Error("The server doesn't join channels.")
  }

  sendMessage(targetId: PeerId, channelId: ChannelId, message: Uint8Array) {
    if (message.byteLength === 0) {
      throw new Error("tried to send a zero-length message")
    }
    const senderId = this.peerId
    if (!senderId) {
      throw new Error("No peerId set for the websocket server network adapter.")
    }

    const decoded: DecodedMessage = {
      senderId,
      targetId,
      channelId,
      type: "sync",
      data: message,
    }
    const encoded = CBOR.encode(decoded)

    // This incantation deals with websocket sending the whole
    // underlying buffer even if we just have a uint8array view on it
    const arrayBuf = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    )

    log(
      `[${senderId}->${targetId}@${channelId}] "sync" | ${arrayBuf.byteLength} bytes`
    )
    this.sockets[targetId].send(arrayBuf)
  }

  receiveMessage(message: Uint8Array, socket: WebSocket) {
    const cbor = CBOR.decode(message)
    const { type, channelId, senderId, targetId, data } = cbor
    const myPeerId = this.peerId
    if (!myPeerId) {
      throw new Error("Missing my peer ID.")
    }
    log(
      `[${senderId}->${myPeerId}@${channelId}] ${type} | ${message.byteLength} bytes`
    )
    switch (type) {
      case "join":
        // Let the rest of the system know that we have a new connection.
        this.emit("peer-candidate", { peerId: senderId, channelId })
        this.sockets[senderId] = socket

        // In this client-server connection, there's only ever one peer: us!
        // (and we pretend to be joined to every channel)
        socket.send(
          CBOR.encode({ type: "peer", senderId: this.peerId, channelId })
        )
        break
      case "leave":
        // ?
        break
      case "sync":
        this.emit("message", {
          senderId,
          targetId,
          channelId,
          message: new Uint8Array(data),
        })
        break
      default:
        // log("unrecognized message type")
        break
    }
  }
}
