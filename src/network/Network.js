/**
 * AutomergeNetwork
 * We use channels to group communication with peers.
 * All messages are from a peer and on a channel.
 * API:
 * join(channel): to be introduced to all peers active on that channel
 * on(peer): listen to receive notifications about new peers
 * leave(channel): does what you'd expect
 *
 * peers are:
 * {
 *   id: string,
 *   isOpen(): bool, // are we still connected?
 *   send(msg): transmit a message to a peer
 * }
 *
 * TODO: peer validation &c
 *
 */

// eslint-disable-next-line max-classes-per-file
class AutomergePeer extends EventTarget {
  id
  isOpen
  send

  constructor(id, isOpen, send) {
    super()

    this.id = id
    this.isOpen = isOpen
    this.send = send
  }
}

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

      if (this.peers[peerId] && !this.peers[peerId].isOpen()) {
        console.log('Discarding peer candidate. We already have a connection.')
        return
      }

      const { isOpen, send } = connection
      const peer = new AutomergePeer(peerId, isOpen, send)

      // TODO: this is where we should authenticate candidates
      this.peers[peerId] = peer
      this.dispatchEvent(new CustomEvent('peer', { detail: { peer, channel } }))
    })

    networkAdapter.addEventListener('message', (ev) => {
      const { peerId, channel, message } = ev.detail
      const peer = this.peers[peerId]
      peer.dispatchEvent(new CustomEvent('message', { detail: { channel, message } }))
    })
  }

  join(channel) {
    this.networkAdapters.forEach((a) => a.join(channel))
  }

  leave(channel) {
    this.networkAdapters.forEach((a) => a.leave(channel))
  }
}
