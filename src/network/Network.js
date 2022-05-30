import EventEmitter from 'eventemitter3'

export default class AutomergeNetwork extends EventEmitter {
  networkAdapters = []

  peers = {}

  constructor(networkAdapters) {
    super()
    this.peerId = `user-${Math.round(Math.random() * 100000)}`
    
    // this really ought to do some input checking
    // eslint-disable-next-line no-param-reassign
    if (!Array.isArray(networkAdapters)) {
      throw new Error('AutomergeNetwork takes an array of networkadapters')
    }

    this.networkAdapters = networkAdapters
    networkAdapters.forEach((a) => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter) {
    networkAdapter.connect(this.peerId)
    networkAdapter.on('peer-candidate', ({ peerId, channel, connection }) => {
      if (!this.peers[peerId] || !this.peers[peerId].isOpen()) {
        const { isOpen, send } = connection
        this.peers[peerId] = { peerId, isOpen, send }
      }

      this.emit('peer', { peerId, channel })
    })

    networkAdapter.on('message', ({ peerId, channel, message }) => {
      this.emit('message', { peerId, channel, message })
    })
  }

  onMessage(peerId, message) {
    const peer = this.peers[peerId]
    peer.send(message)
  }

  join(channel) {
    this.networkAdapters.forEach((a) => a.join(channel))
  }

  leave(channel) {
    this.networkAdapters.forEach((a) => a.leave(channel))
  }
}
