import * as CBOR from "cbor-x"
import {
  ChannelId,
  DecodedMessage,
  NetworkAdapter,
  NetworkConnection,
  PeerId,
} from "automerge-repo"
import * as Automerge from "@automerge/automerge"
import WebSocket from "isomorphic-ws"

export interface WebSocketNetworkAdapter extends NetworkAdapter {
  client?: WebSocket
}

export function sendMessage(
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

function prepareConnection(
  channelId: ChannelId,
  destinationId: PeerId,
  socket: WebSocket,
  sourceId: PeerId
) {
  const connection: NetworkConnection = {
    close: () => socket.close(),
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (message) =>
      sendMessage(destinationId, socket, channelId, sourceId, message),
  }
  return connection
}

export function receiveMessageClient(
  message: Uint8Array,
  self: WebSocketNetworkAdapter
) {
  const decoded = CBOR.decode(new Uint8Array(message)) as DecodedMessage
  const { type, senderId, channelId, data } = decoded

  const socket = self.client
  if (!socket) {
    throw new Error("Missing client at receiveMessage")
  }

  if (message.byteLength === 0) {
    throw new Error("received a zero-length message")
  }

  switch (type) {
    case "peer":
      // console.log(`peer: ${senderId}, ${channelId}`)
      const myPeerId = self.peerId
      if (!myPeerId) {
        throw new Error("Local peer ID not set!")
      }

      const connection = prepareConnection(
        channelId,
        senderId,
        socket,
        myPeerId
      )
      self.emit("peer-candidate", { peerId: senderId, channelId, connection })
      break
    default:
      self.emit("message", {
        channelId,
        senderId,
        message: new Uint8Array(data),
      })
  }
}

export function receiveMessageServer(
  message: Uint8Array,
  socket: WebSocket,
  self: WebSocketNetworkAdapter
) {
  const cbor = CBOR.decode(message)
  const { type, channelId, senderId, data } = cbor
  const myPeerId = self.peerId
  if (!myPeerId) {
    throw new Error("Missing my peer ID.")
  }
  console.log(
    `[${senderId}->${myPeerId}@${channelId}] ${type} | ${message.byteLength} bytes`
  )
  switch (type) {
    case "join":
      // Let the rest of the system know that we have a new connection.
      const connection = prepareConnection(
        channelId,
        senderId,
        socket,
        myPeerId
      )
      self.emit("peer-candidate", { peerId: senderId, channelId, connection })
      // In this client-server connection, there's only ever one peer: us!
      socket.send(
        CBOR.encode({ type: "peer", senderId: self.peerId, channelId })
      )
      break
    case "leave":
      // ?
      break
    case "sync":
      self.emit("message", {
        senderId,
        channelId,
        message: new Uint8Array(data),
      })
      break
    default:
      // console.log("unrecognized message type")
      break
  }
}
