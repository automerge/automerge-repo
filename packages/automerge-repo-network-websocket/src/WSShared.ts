import * as CBOR from "cbor-x"
import {
  DecodedMessage,
  NetworkAdapter,
  NetworkConnection,
} from "automerge-repo"
import * as Automerge from "@automerge/automerge"
import WebSocket from "isomorphic-ws"

export interface WebSocketNetworkAdapter extends NetworkAdapter {
  client?: WebSocket
}

export function sendMessage(
  destinationId: string,
  socket: WebSocket,
  channelId: string,
  senderId: string,
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

function announceConnection(
  channelId: string,
  peerId: string,
  socket: WebSocket,
  self: NetworkAdapter
) {
  // return a peer object
  const myPeerId = self.peerId
  if (!myPeerId) {
    throw new Error("we should have a peer ID by now")
  }

  const connection: NetworkConnection = {
    close: () => socket.close(),
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (message) =>
      sendMessage(peerId, socket, channelId, myPeerId, message),
  }
  self.emit("peer-candidate", { peerId, channelId, connection })
}

export function receiveMessageClient(
  message: Uint8Array,
  self: WebSocketNetworkAdapter
) {
  const decoded = CBOR.decode(new Uint8Array(message)) as DecodedMessage
  const { type, senderId, channelId, data } = decoded

  const client = self.client
  if (!client) {
    throw new Error("Missing client at receiveMessage")
  }

  if (message.byteLength === 0) {
    throw new Error("received a zero-length message")
  }

  switch (type) {
    case "peer":
      // console.log(`peer: ${senderId}, ${channelId}`)
      announceConnection(channelId, senderId, client, self)
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
  console.log(
    `[${senderId}->${self.peerId}@${channelId}] ${type} | ${data.byteLength} bytes`
  )
  switch (type) {
    case "join":
      announceConnection(channelId, senderId, socket, self)
      console.log("ready?", socket.readyState)
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
