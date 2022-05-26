class BroadcastChannelNetworkAdapter extends EventTarget {
  channels = {}

  connect(clientId) {
    this.clientId = clientId
  }

  #announceConnection(channel, peerId, broadcastChannel) {
    // return a peer object
    const connection = {
      close: () => {}, /* not sure what it would mean to close this yet */
      isOpen: () => true,
      send: (uint8message) => {
        const message = uint8message.buffer.slice(
          uint8message.byteOffset,
          uint8message.byteOffset + uint8message.byteLength,
        )
        broadcastChannel.postMessage({
          origin: this.clientId, destination: peerId, type: 'message', message,
        })
      },
    }
    this.dispatchEvent(new CustomEvent('peer-candidate', { detail: { peerId, channel, connection } }))
  }

  join(channel) {
    const broadcastChannel = new BroadcastChannel(`doc-${channel}`)
    broadcastChannel.postMessage({ origin: this.clientId, type: 'arrive' })
    broadcastChannel.addEventListener('message', (e) => {
      const {
        origin, destination, type, message,
      } = e.data
      if (destination && destination !== this.clientId) {
        return
      }
      switch (type) {
        case 'arrive':
          broadcastChannel.postMessage({ origin: this.clientId, destination: origin, type: 'welcome' })
          this.#announceConnection(channel, origin, broadcastChannel)
          break
        case 'welcome':
          this.#announceConnection(channel, origin, broadcastChannel)
          break
        case 'message':
          this.dispatchEvent(new CustomEvent('message', { detail: { peerId: origin, channel, message: new Uint8Array(message) } }))
          break
        default:
          throw new Error('unhandled message from network')
      }
    })
  }

  leave(docId) {
    this.doSomething(docId)
    // TODO
  }
}

export default BroadcastChannelNetworkAdapter
