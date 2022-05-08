/* eslint-disable import/extensions */
import { Client } from '../../vendor/Client.js'

class LocalFirstRelayNetworkAdapter extends EventTarget {
  url
  client

  constructor(url) {
    super()
    this.url = url
  }

  connect(peerId) {
    this.client = new Client({
      userName: peerId,
      url: this.url,
    })
    
    this.client.addEventListener('peer.connect', (ev) => {
      const { documentId, userName, socket } = ev.detail
      socket.binaryType = 'arraybuffer'
      const connection = {
        isOpen: () => socket.readyState === WebSocket.OPEN,
        send: (msg) => socket.send(msg.buffer),
      }
      this.dispatchEvent(new CustomEvent('peer', { detail: { peerId: userName, documentId, connection } }))

      // listen for messages
      socket.onmessage = (e) => {
        const message = new Uint8Array(e.data)
        this.dispatchEvent(new CustomEvent('message', { detail: { peerId: userName, documentId, message } }))
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
