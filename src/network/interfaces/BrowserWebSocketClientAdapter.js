import EventEmitter from 'eventemitter3'
import * as CBOR from 'cbor-x'
import { receiveMessageClient } from './WSShared.js'

class BrowserWebSocketClientAdapter extends EventEmitter {
  client
  openSockets = []

  constructor(url) {
    super()
    this.url = url
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

    this.client.addEventListener('message', event => receiveMessageClient(event.data, this))
  }

  join(channelId) {
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(CBOR.encode({type: "join", channelId, senderId: this.peerId}))
    }
    else {
      this.client.addEventListener('open', () => {
        this.client.send(CBOR.encode({type: "join", channelId, senderId: this.peerId}))
      }, { once: true })
    }
  }

  leave(channelId) {
    this.client.send(CBOR.encode({type: "leave", channelId, senderId: this.peerId}))
  }
}

export default BrowserWebSocketClientAdapter

