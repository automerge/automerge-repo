import { Client } from './Client.js'

class NetworkInterface extends EventTarget {
  client

  constructor(url) {
    super()
    const client = new Client({
      userName: `user-${Math.round(Math.random() * 1000)}`,
      url,
    })
    this.client = client

    client.addEventListener('peer.connect', (ev) => {
      const { documentId, userName, socket } = ev.detail
      socket.binaryType = 'arraybuffer'
      const connection = {
        isOpen: () => socket.readyState === WebSocket.OPEN,
        send: (msg) => socket.send(msg.buffer),
      }
      this.dispatchEvent(new CustomEvent('peer', { detail: { peerId: userName, documentId, connection } }))

      // listen for messages
      socket.onmessage = (e) => {
        console.log(e.data)
        const message = new Uint8Array(e.data)
        this.dispatchEvent(new CustomEvent('message', { detail: { peerId: userName, documentId, message } }))
      }
    })
  }

  join(docId) {
    this.client.join(docId)
  }
}

export default NetworkInterface
