import { Client } from '@localfirst/relay-client'
import EventEmitter from 'eventemitter3'

class LocalFirstRelayNetworkAdapter extends EventEmitter {
  url
  client

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
        socket.send(message)
      },
    }
    this.emit('peer-candidate', { peerId, channel, connection })
  }

  connect(peerId) {
    this.client = new Client({
      userName: peerId,
      url: this.url,
    })

    this.client.on('peer.connect', (ev) => {
      const { documentId, userName, socket } = ev.detail
      socket.binaryType = 'arraybuffer'
      this.#announceConnection(documentId, userName, socket)

      // listen for messages
      socket.onmessage = (e) => {
        const message = new Uint8Array(e.data)
        this.emit('message', { peerId: userName, channel: documentId, message })
      }
    })
  }

  join(docId) {
    this.client.join(docId)
  }

  leave(docId) {
    this.client.leave(docId)
  }
}

export default LocalFirstRelayNetworkAdapter
