import EventEmitter from 'eventemitter3'

export default class AutomergeNetwork extends EventEmitter {
  networkAdapters = []

  peers = {}

  constructor(networkAdapters) {
    super()
    this.peerId = `user-${Math.round(Math.random() * 100000)}`
    console.log("We are: ", this.peerId)
    
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
    networkAdapter.on('peer-candidate', ({ peerId, channelId, connection }) => {
      if (!this.peers[peerId] || !this.peers[peerId].isOpen()) {
        const { isOpen, send } = connection
        this.peers[peerId] = { peerId, isOpen, send }
      }

      this.emit('peer', { peerId, channelId })
    })

    networkAdapter.on('message', msg => {
      this.emit('message', msg)
    })
  }

  onMessage(peerId, message) {
    console.log("message to:", peerId, ":", this.peers)
    const peer = this.peers[peerId]
    peer.send(message)
  }

  join(channelId) {
    this.networkAdapters.forEach((a) => a.join(channelId))
  }

  leave(channelId) {
    this.networkAdapters.forEach((a) => a.leave(channelId))
  }
}
