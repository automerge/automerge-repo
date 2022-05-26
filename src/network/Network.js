import AutomergePeer from './AutomergePeer.js'

export default class AutomergeNetwork extends EventTarget {
  networkAdapters = []

  peers = {}

  constructor(networkAdapters) {
    super()
    // hmmm... persist this?
    this.peerId = `user-${Math.round(Math.random() * 1000)}`
    // this really ought to do some input checking
    // eslint-disable-next-line no-param-reassign
    if (!Array.isArray(networkAdapters)) { networkAdapters = [networkAdapters] }
    this.networkAdapters = networkAdapters
    networkAdapters.forEach((a) => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter) {
    networkAdapter.connect(this.peerId)
    networkAdapter.addEventListener('peer-candidate', (ev) => {
      const { peerId, channel, connection } = ev.detail

      if (!this.peers[peerId] || !this.peers[peerId].isOpen()) {
        const { isOpen, send } = connection
        this.peers[peerId] = new AutomergePeer(peerId, isOpen, send)
      }

      // TODO: this is where we should authenticate candidates
      this.dispatchEvent(new CustomEvent('peer', { detail: { peerId, channel } }))
    })

    networkAdapter.addEventListener('message', (ev) => {
      // todo: filter out messages from handshakes
      const { peerId, channel, message } = ev.detail
      this.dispatchEvent(new CustomEvent('message', { detail: { peerId, channel, message } }))
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
