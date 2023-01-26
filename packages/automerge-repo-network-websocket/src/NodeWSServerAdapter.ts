import * as CBOR from "cbor-x"
import { WebSocket, type WebSocketServer } from "isomorphic-ws"

import debug from "debug"

import {
  ChannelId,
  InboundMessagePayload,
  MessagePayload,
  NetworkAdapter,
  PeerId,
} from "automerge-repo"

export class NodeWSServerAdapter extends NetworkAdapter {
  server: WebSocketServer
  sockets: { [peerId: PeerId]: WebSocket } = {}
  log = debug("ar:wsserver")

  logMessage = (
    direction: "send" | "receive",
    payload: MessagePayload | InboundMessagePayload
  ) => {
    const {
      type = "unknown type",
      targetId = "?",
      channelId = "?",
      message,
    } = payload as InboundMessagePayload
    const arrow = direction === "send" ? "->" : "<-"
    const channelIdShort = channelId.slice(0, 8)
    this.log(
      `${arrow} ${type} ${targetId} ${channelIdShort} | ${
        message?.byteLength ?? 0
      }b`
    )
  }

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

  join(_: ChannelId) {
    // throw new Error("The server doesn't join channels.")
  }

  leave(_: ChannelId) {
    // throw nebw Error("The server doesn't join channels.")
  }

  sendMessage(
    targetId: PeerId,
    channelId: ChannelId,
    message: Uint8Array,
    broadcast: boolean
  ) {
    if (message.byteLength === 0)
      throw new Error("tried to send a zero-length message")
    const senderId = this.peerId
    if (!senderId)
      throw new Error("No peerId set for the websocket server network adapter.")
    if (this.sockets[targetId] === undefined) {
      this.log(`Tried to send message to disconnected peer: ${targetId}`)
      return
    }

    const decoded: InboundMessagePayload = {
      senderId,
      targetId,
      channelId,
      type: "sync",
      message,
      broadcast,
    }
    this.logMessage("send", decoded)

    const encoded = CBOR.encode(decoded)

    // This incantation deals with websocket sending the whole
    // underlying buffer even if we just have a uint8array view on it
    const arrayBuf = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    )

    this.sockets[targetId].send(arrayBuf)
  }

  receiveMessage(payload: Uint8Array, socket: WebSocket) {
    const decoded = CBOR.decode(payload)
    const { type, channelId, senderId, targetId, message, broadcast } = decoded
    const myPeerId = this.peerId
    if (!myPeerId) {
      throw new Error("Missing my peer ID.")
    }
    this.logMessage("receive", {
      type,
      targetId: senderId,
      message,
      channelId,
      broadcast,
    })
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
        // It doesn't seem like this gets called;
        // we handle leaving in the socket close logic
        // TODO: confirm this
        // ?
        break
      case "message":
        this.emit("message", {
          senderId,
          targetId,
          channelId,
          message,
          broadcast,
        })
        break
      default:
        this.log("unrecognized message type")
        break
    }
  }
}
