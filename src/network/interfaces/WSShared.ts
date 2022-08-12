import * as CBOR from 'cbor-x'
import { DecodedMessage, NetworkAdapter, NetworkConnection } from '../Network'
import WebSocket from 'isomorphic-ws'

export interface WebSocketNetworkAdapter extends NetworkAdapter {
  client?: WebSocket
}

export function sendMessage(socket: WebSocket, channelId: string, senderId: string, message: Uint8Array) {
  if (message.byteLength === 0) { throw new Error("tried to send a zero-length message")}
  const decoded: DecodedMessage = {senderId, channelId, type: 'sync', data: message}
  const encoded = CBOR.encode(decoded)

  // This incantation deals with websocket sending the whole
  // underlying buffer even if we just have a uint8array view on it
  const arrayBuf = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  )
  socket.send(arrayBuf)
}

function announceConnection(channelId: string, peerId: string, socket: WebSocket, self: NetworkAdapter) {
  // return a peer object
  const myPeerId = self.peerId
  if (!myPeerId) { throw new Error("we should have a peer ID by now")}

  const connection: NetworkConnection = {
    close: () => socket.close(),
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (message) => sendMessage(socket, channelId, myPeerId, message),
  }
  self.emit('peer-candidate', { peerId, channelId, connection })
}

export function receiveMessageClient(message: Uint8Array, self: WebSocketNetworkAdapter) {
  const decoded = CBOR.decode(new Uint8Array(message)) as DecodedMessage
  console.log(decoded)
  const { type, senderId, channelId, data } = decoded
  console.log('Received message: ', event)

  const client = self.client
  if (!client) { throw new Error("Missing client at receiveMessage") }

  if (message.byteLength === 0) { throw new Error("received a zero-length message") }

  switch (type) {
    case "peer":
      console.log(`peer: ${senderId}, ${channelId}`)
      announceConnection(channelId, senderId, client, self)
      break
    default:
      self.emit('message', { channelId, senderId, message: new Uint8Array(data) })
  }
}

export function receiveMessageServer(message: Uint8Array, socket: WebSocket, self: WebSocketNetworkAdapter) {
  const cbor = CBOR.decode(message)
  console.log("received: ", cbor)
  const { type, channelId, senderId, data } = cbor
  switch(type) {
    case "join":
      announceConnection(channelId, senderId, socket, self)
      socket.send(CBOR.encode({type: 'peer', senderId: self.peerId, channelId}))
      break
    case "leave":
      // ?
      break
    case "sync":
      self.emit('message', { senderId, channelId, message: new Uint8Array(data) })
      break
    default:
      console.log("unrecognized message type")
      break
  } 
}

