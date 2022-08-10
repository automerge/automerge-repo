import EventEmitter from 'eventemitter3'
import * as CBOR from 'cbor-x'

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
class BrowserWebSocketClientAdapter extends EventEmitter {
  client
  openSockets = []

  constructor(url) {
    super()
    this.url = url
  }

  #announceConnection(channelId, peerId, socket) {
    // return a peer object
    const connection = {
      close: () => socket.close(),
      isOpen: () => socket.readyState === WebSocket.OPEN,
      send: (message) => {
        if (message.byteLength === 0) { throw new Error("tried to send a zero-length message")}

        const type = 'sync'
        const wrappedMessage = CBOR.encode({channelId, peerId, type, data: message})

        const data = wrappedMessage.buffer.slice(
          wrappedMessage.byteOffset,
          wrappedMessage.byteOffset + wrappedMessage.byteLength,
        )

        console.log(`sending (${data.byteLength } bytes) ${arrayBufferToHex(data)}` )
        socket.send(data)
      },
    }
    this.emit('peer-candidate', { peerId, channelId, connection })
  }

  
  connect(peerId) {
    this.peerId = peerId
    this.client = new WebSocket(this.url)
    this.client.binaryType = "arraybuffer";

    this.client.addEventListener('open', event => {
      const socket = event.target

      console.log("Connected to server.")
    })


      // When a socket closes, or disconnects, remove it from the array.
    this.client.addEventListener('close',  () => {
      console.log('Disconnected from server')
      // TODO: manage reconnection here
    })

    this.client.addEventListener('message', event => {
      const message = CBOR.decode(new Uint8Array(event.data))
      const { type, peerId, channelId, data } = message
      console.log('Received message: ', event)

      if (message.byteLength === 0) { throw new Error("received a zero-length message") }

      switch (type) {
        case "peer":
          console.log(`peer: ${peerId}, ${channelId}`)
          this.#announceConnection(channelId, peerId, this.client)
        default:
          this.emit('message', { channelId, peerId, message: new Uint8Array(data) })
      }
    })
  }

  join(channelId) {
    const { peerId } = this
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(CBOR.encode({type: "join", channelId, peerId}))
    }
    else {
      this.client.addEventListener('open', () => {
        this.client.send(CBOR.encode({type: "join", channelId, peerId}))
      }, { once: true })
    }
  }

  leave(channelId) {
    const { peerId } = this
    this.client.send(CBOR.encode({type: "leave", channelId, peerId}))
  }
}

export default BrowserWebSocketClientAdapter

