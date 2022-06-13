import EventEmitter from 'eventemitter3'
import * as CBOR from 'cbor-x'

class BrowserWebSocketClientAdapter extends EventEmitter {
  client
  openSockets = []

  constructor(url) {
    super()
    this.url = url
  }

  #announceConnection(channel, peerId, socket) {
    // return a peer object
    const connection = {
      close: () => socket.close(),
      isOpen: () => socket.readyState === WebSocket.OPEN,
      send: (uint8message) => {
        const message = uint8message.buffer.slice(
          uint8message.byteOffset,
          uint8message.byteOffset + uint8message.byteLength,
        )
        console.log("sending", message )
        if (message.byteLength === 0) { throw new Error("tried to send a zero-length message")}
        socket.send(message)
      },
    }
    this.emit('peer-candidate', { peerId, channel, connection })
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
      const { type, peerId, channel, data } = message
      console.log('Received message: ', event)

      if (message.byteLength === 0) { throw new Error("received a zero-length message") }

      switch (type) {
        case "peer":
          console.log(`peer: ${peerId}, ${channel}`)
          this.#announceConnection(channel, peerId, this.client)
        default:
          this.emit('message', { peerId, channel, message: new Uint8Array(data) })
      }
    })
  }

  join(channel) {
    const { peerId } = this
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(CBOR.encode({type: "join", channel, peerId}))
    }
    else {
      this.client.addEventListener('open', () => {
        this.client.send(CBOR.encode({type: "join", channel, peerId}))
      }, { once: true })
    }
  }

  leave(channel) {
    const { peerId } = this
    this.client.send(CBOR.encode({type: "leave", channel, peerId}))
  }
}

export default BrowserWebSocketClientAdapter

