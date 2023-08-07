import * as CBOR from "cbor-x"
import { WebSocket, type WebSocketServer } from "isomorphic-ws"

import debug from "debug"
const log = debug("WebsocketServer")

import {
  ChannelId,
  InboundMessagePayload,
  NetworkAdapter,
  PeerId,
} from "@automerge/automerge-repo"
import {ProtocolV1, ProtocolVersion} from "./protocolVersion"
import {InboundWebSocketMessage} from "./message"

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

  sendMessage(
    targetId: PeerId,
    channelId: ChannelId,
    message: Uint8Array,
    broadcast: boolean
  ) {
    if (message.byteLength === 0) {
      throw new Error("tried to send a zero-length message")
    }
    const senderId = this.peerId
    if (!senderId) {
      throw new Error("No peerId set for the websocket server network adapter.")
    }
    if (this.sockets[targetId] === undefined) {
      log(`Tried to send message to disconnected peer: ${targetId}`)
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
    const cbor: InboundWebSocketMessage = CBOR.decode(message)

    const {
      type,
      channelId,
      senderId,
      targetId,
      message: data,
      broadcast,
      supportedProtocolVersions,
    } = cbor

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
        this.emit("peer-candidate", { peerId: senderId })
        this.sockets[senderId] = socket

        // In this client-server connection, there's only ever one peer: us!
        // (and we pretend to be joined to every channel)
        const selectedProtocolVersion = selectProtocol(supportedProtocolVersions)
        if (selectedProtocolVersion === null) {
          socket.send(CBOR.encode({ type: "error", errorMessage: "unsupported protocol version"}))
          this.sockets[senderId].close()
          delete this.sockets[senderId]
        } else {
          socket.send(
            CBOR.encode({
              type: "peer",
              senderId: this.peerId,
              selectedProtocolVersion: ProtocolV1,
            })
          )
        }
        break
      case "leave":
        // It doesn't seem like this gets called;
        // we handle leaving in the socket close logic
        // TODO: confirm this
        // ?
        break

      // We accept both "message" and "sync" because a previous version of this
      // codebase sent sync messages in the BrowserWebSocketClientAdapter as
      // type "message" and we want to stay backwards compatible
      case "message":
      case "sync":
        this.emit("message", {
          senderId,
          targetId,
          channelId,
          message: new Uint8Array(data),
          broadcast,
        })
        break
      default:
        log(`unrecognized message type ${type}`)
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
