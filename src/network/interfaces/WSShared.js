import * as CBOR from 'cbor-x'

export function sendMessage(socket, channelId, senderId, message) {
  if (message.byteLength === 0) { throw new Error("tried to send a zero-length message")}
  const wrappedMessage = CBOR.encode({senderId, channelId, type: 'sync', data: message})

  console.log("SENDMESSAGE:", arrayBufferToHex(wrappedMessage))

  // This incantation deals with websocket sending the whole
  // underlying buffer even if we just have a uint8array view on it
  const arrayBuf = wrappedMessage.buffer.slice(
    wrappedMessage.byteOffset,
    wrappedMessage.byteOffset + wrappedMessage.byteLength,
  )
  socket.send(arrayBuf)
}

function announceConnection(channelId, peerId, socket, self) {
  // return a peer object
  const connection = {
    close: () => socket.close(),
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (message) => sendMessage(socket, channelId, self.peerId, message),
  }
  self.emit('peer-candidate', { peerId, channelId, connection })
}

export function receiveMessageClient(message, self) {
  const decoded = CBOR.decode(new Uint8Array(message))
  console.log(decoded)
  const { type, senderId, channelId, data } = decoded
  console.log('Received message: ', event)

  if (message.byteLength === 0) { throw new Error("received a zero-length message") }

  switch (type) {
    case "peer":
      console.log(`peer: ${senderId}, ${channelId}`)
      announceConnection(channelId, senderId, self.client, self)
      break;
    default:
      self.emit('message', { channelId, senderId, message: new Uint8Array(data) })
  }
}

export function receiveMessageServer(message, socket, self) {
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

function arrayBufferToHex (arrayBuffer) {
  if (typeof arrayBuffer !== 'object' || arrayBuffer === null || typeof arrayBuffer.byteLength !== 'number') {
    throw new TypeError('Expected input to be an ArrayBuffer')
  }

  var view = new Uint8Array(arrayBuffer)
  var result = ''
  var value

  for (var i = 0; i < view.length; i++) {
    value = view[i].toString(16)
    result += (value.length === 1 ? '0' + value : value)
  }

  return result
}
