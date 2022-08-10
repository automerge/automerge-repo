import EventEmitter from 'eventemitter3'
import { WebSocketServer } from 'ws'
import { receiveMessageServer } from './WSShared.js'

class NodeWSServerAdapter extends EventEmitter {
  server
  openSockets = []

  connect(peerId) {
    this.peerId = peerId
    this.server = new WebSocketServer({ noServer: true })
    this.server.on('connection', socket => {
      console.log('New WebSocket connection')
      this.openSockets.push(socket)

      // When a socket closes, or disconnects, remove it from the array.
      socket.on('close', () => {
        console.log('Disconnected')
        this.openSockets = this.openSockets.filter(s => s !== socket)
      })

      socket.on('message', message => receiveMessageServer(message, socket, this))

    })
  }

  join(docId) {
    // throw new Error("The server doesn't join channels.")
  }

  leave(docId) {
    // throw new Error("The server doesn't join channels.")
  }
}

export default NodeWSServerAdapter

