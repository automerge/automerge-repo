import WebSocket from "isomorphic-ws"
import { type WebSocketServer } from "isomorphic-ws"

import debug from "debug"
const log = debug("WebsocketServer")

import {
  cbor as cborHelpers,
  NetworkAdapter,
  type PeerMetadata,
  type PeerId,
} from "@automerge/automerge-repo"
import {
  FromClientMessage,
  FromServerMessage,
  isJoinMessage,
  isLeaveMessage,
} from "./messages.js"
import { ProtocolV1, ProtocolVersion } from "./protocolVersion.js"
import { assert } from "./assert.js"
import { toArrayBuffer } from "./toArrayBuffer.js"

const { encode, decode } = cborHelpers

export class NodeWSServerAdapter extends NetworkAdapter {
  sockets: { [peerId: PeerId]: WebSocket } = {}

  constructor(
    private server: WebSocketServer,
    private keepAliveInterval = 5000
  ) {
    super()
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata) {
    this.peerId = peerId
    this.peerMetadata = peerMetadata

    this.server.on("close", () => {
      clearInterval(keepAliveId)
      this.disconnect()
    })

    this.server.on("connection", (socket: WebSocketWithIsAlive) => {
      // When a socket closes, or disconnects, remove it from our list
      socket.on("close", () => {
        this.#removeSocket(socket)
      })

      socket.on("message", message =>
        this.receiveMessage(message as Uint8Array, socket)
      )

      // Start out "alive", and every time we get a pong, reset that state.
      socket.isAlive = true
      socket.on("pong", () => (socket.isAlive = true))

      this.emit("ready", { network: this })
    })

    const keepAliveId = setInterval(() => {
      // Terminate connections to lost clients
      const clients = this.server.clients as Set<WebSocketWithIsAlive>
      clients.forEach(socket => {
        if (socket.isAlive) {
          // Mark all clients as potentially dead until we hear from them
          socket.isAlive = false
          socket.ping()
        } else {
          this.#terminate(socket)
        }
      })
    }, this.keepAliveInterval)
  }

  disconnect() {
    const clients = this.server.clients as Set<WebSocketWithIsAlive>
    clients.forEach(socket => {
      this.#terminate(socket)
      this.#removeSocket(socket)
    })
  }

  send(message: FromServerMessage) {
    assert("targetId" in message && message.targetId !== undefined)
    if ("data" in message && message.data?.byteLength === 0)
      throw new Error("Tried to send a zero-length message")

    const senderId = this.peerId
    assert(senderId, "No peerId set for the websocket server network adapter.")

    const socket = this.sockets[message.targetId]

    if (!socket) {
      log(`Tried to send to disconnected peer: ${message.targetId}`)
      return
    }

    const encoded = encode(message)
    const arrayBuf = toArrayBuffer(encoded)

    socket.send(arrayBuf)
  }

  receiveMessage(messageBytes: Uint8Array, socket: WebSocket) {
    const message: FromClientMessage = decode(messageBytes)

    const { type, senderId } = message

    const myPeerId = this.peerId
    assert(myPeerId)

    const documentId = "documentId" in message ? "@" + message.documentId : ""
    const { byteLength } = messageBytes
    log(`[${senderId}->${myPeerId}${documentId}] ${type} | ${byteLength} bytes`)

    if (isJoinMessage(message)) {
      const { peerMetadata, supportedProtocolVersions } = message
      const existingSocket = this.sockets[senderId]
      if (existingSocket) {
        if (existingSocket.readyState === WebSocket.OPEN) {
          existingSocket.close()
        }
        this.emit("peer-disconnected", { peerId: senderId })
      }

      // Let the repo know that we have a new connection.
      this.emit("peer-candidate", { peerId: senderId, peerMetadata })
      this.sockets[senderId] = socket

      const selectedProtocolVersion = selectProtocol(supportedProtocolVersions)
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
          peerMetadata: this.peerMetadata!,
          selectedProtocolVersion: ProtocolV1,
          targetId: senderId,
        })
      }
    } else if (isLeaveMessage(message)) {
      const { senderId } = message
      const socket = this.sockets[senderId]
      /* c8 ignore next */
      if (!socket) return
      this.#terminate(socket as WebSocketWithIsAlive)
    } else {
      this.emit("message", message)
    }
  }

  #terminate(socket: WebSocketWithIsAlive) {
    this.#removeSocket(socket)
    socket.terminate()
  }

  #removeSocket(socket: WebSocketWithIsAlive) {
    const peerId = this.#peerIdBySocket(socket)
    if (!peerId) return
    this.emit("peer-disconnected", { peerId })
    delete this.sockets[peerId as PeerId]
  }

  #peerIdBySocket = (socket: WebSocket) => {
    const isThisSocket = (peerId: string) =>
      this.sockets[peerId as PeerId] === socket
    const result = Object.keys(this.sockets).find(isThisSocket) as PeerId
    return result ?? null
  }
}

const selectProtocol = (versions?: ProtocolVersion[]) => {
  if (versions === undefined) return ProtocolV1
  if (versions.includes(ProtocolV1)) return ProtocolV1
  return null
}

interface WebSocketWithIsAlive extends WebSocket {
  isAlive: boolean
}
