import EventEmitter from "eventemitter3"
import * as ws from "isomorphic-ws"
import { type WebSocketServer, WebSocket } from "isomorphic-ws"
import * as CBOR from "cbor-x"

import {
  ChannelId,
  DecodedMessage,
  NetworkAdapter,
  NetworkAdapterEvents,
  NetworkConnection,
  PeerId,
} from "automerge-repo"

export class NodeWSServerAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements NetworkAdapter
{
  peerId?: PeerId
  server: WebSocketServer
  sockets: WebSocket[] = []

  constructor(server: WebSocketServer) {
    super()
    this.server = server
  }

  connect(peerId: PeerId) {
    this.peerId = peerId
    this.server.on("connection", (socket) => {
      this.sockets.push(socket)

      // When a socket closes, or disconnects, remove it from the array.
      socket.on("close", () => {
        this.sockets = this.sockets.filter((s) => s !== socket)
      })

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

  sendMessage(
    destinationId: PeerId,
    socket: WebSocket,
    channelId: ChannelId,
    senderId: PeerId,
    message: Uint8Array
  ) {
    if (message.byteLength === 0) {
      throw new Error("tried to send a zero-length message")
    }
    const decoded: DecodedMessage = {
      senderId,
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

    console.log(
      `[${senderId}->${destinationId}@${channelId}] "sync" | ${arrayBuf.byteLength} bytes`
    )
    socket.send(arrayBuf)
  }

  prepareConnection(
    destinationId: PeerId,
    socket: WebSocket,
    sourceId: PeerId
  ) {
    const connection: NetworkConnection = {
      close: () => socket.close(),
      isOpen: () => socket.readyState === ws.OPEN,
      send: (channelId, message) =>
        this.sendMessage(destinationId, socket, channelId, sourceId, message),
    }
    return connection
  }

  receiveMessage(message: Uint8Array, socket: WebSocket) {
    const cbor = CBOR.decode(message)
    const { type, channelId, senderId, data } = cbor
    const myPeerId = this.peerId
    if (!myPeerId) {
      throw new Error("Missing my peer ID.")
    }
    console.log(
      `[${senderId}->${myPeerId}@${channelId}] ${type} | ${message.byteLength} bytes`
    )
    switch (type) {
      case "join":
        // Let the rest of the system know that we have a new connection.
        const connection = this.prepareConnection(senderId, socket, myPeerId)
        this.emit("peer-candidate", { peerId: senderId, channelId, connection })
        // In this client-server connection, there's only ever one peer: us!
        socket.send(
          CBOR.encode({ type: "peer", senderId: this.peerId, channelId })
        )
        break
      case "leave":
        // ?
        break
      case "sync":
        this.emit("message", {
          peerId: senderId,
          channelId,
          message: new Uint8Array(data),
        })
        break
      default:
        // console.log("unrecognized message type")
        break
    }
  }
}
