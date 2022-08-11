import EventEmitter from 'eventemitter3'

interface PeerDetails {
  peerId: string,
  channelId: string,
  connection: NetworkConnection
}

interface MessageDetails {
  senderId: string,
  channelId: string,
  message: Uint8Array
}

export interface NetworkEvents {
  'peer-candidate': (msg: PeerDetails) => void;
  'message': (msg: MessageDetails) => void;
}

export interface NetworkAdapter extends EventEmitter<NetworkEvents> {
  peerId?: string // hmmm, maybe not
  connect(clientId: string): void
  join(channelId: string): void
  leave(channelId: string): void
}

export interface DecodedMessage {
  type: string,
  senderId: string,
  channelId: string,
  data: Uint8Array,
}

export interface NetworkConnection {
  isOpen(): boolean
  close(): void
  send(msg: Uint8Array): void
}

export default class AutomergeNetwork extends EventEmitter {
  networkAdapters: NetworkAdapter[] = []

  myPeerId
  peers: { [peerId: string] : NetworkConnection } = {}

  constructor(networkAdapters: NetworkAdapter[]) {
    super()
    this.myPeerId = `user-${Math.round(Math.random() * 100000)}`
    console.log("We are: ", this.myPeerId)
    
    this.networkAdapters = networkAdapters
    networkAdapters.forEach((a) => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter: NetworkAdapter) {
    networkAdapter.connect(this.myPeerId)
    networkAdapter.on('peer-candidate', ({ peerId, channelId, connection }) => {
      if (!this.peers[peerId] || !this.peers[peerId].isOpen()) {
        this.peers[peerId] = connection
      }

      this.emit('peer', { peerId, channelId })
    })

    networkAdapter.on('message', msg => {
      this.emit('message', msg)
    })
  }

  onMessage(peerId: string, message: Uint8Array) {
    const peer = this.peers[peerId]
    peer.send(message)
  }

  join(channelId: string) {
    this.networkAdapters.forEach((a) => a.join(channelId))
  }

  leave(channelId: string) {
    this.networkAdapters.forEach((a) => a.leave(channelId))
  }
}
