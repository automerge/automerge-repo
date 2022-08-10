import EventEmitter from 'eventemitter3'
import { WebSocketServer } from 'ws'
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

class NodeWSServerAdapter extends EventEmitter {
  server
  openSockets = []

  #announceConnection(channelId, peerId, socket) {
    // return a peer object
    const connection = {
      close: () => socket.close(),
      isOpen: () => true,
      send: (message) => {
        const type = 'sync'
        const wrappedMessage = CBOR.encode({channelId, peerId, type, data: message})

        const data = wrappedMessage.buffer.slice(
          wrappedMessage.byteOffset,
          wrappedMessage.byteOffset + wrappedMessage.byteLength,
        )
        if (message.byteLength === 0) { throw new Error("tried to send a zero-length message")}

        console.log(`sending (${data.byteLength } bytes) ${arrayBufferToHex(data)}` )
        socket.send(data)
      },
    }
    this.emit('peer-candidate', { peerId, channelId, connection })
  }

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

      socket.on('message', message => {
        console.log("received", arrayBufferToHex(message))
        const cbor = CBOR.decode(message)
        console.log(cbor)
        const { channelId, peerId: myPeerId, type, data } = cbor
        switch(type) {
          case "join": 
            this.#announceConnection(channelId, peerId, socket)
            socket.send(CBOR.encode({type: 'peer', peerId: this.peerId, channelId}))
            break
          case "leave":
            // ?
            break
          case "sync":
            this.emit('message', { peerId, channelId, message: new Uint8Array(data) })
            break
          default:
            console.log("unrecognized message type")
            break
        }  
      })

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

