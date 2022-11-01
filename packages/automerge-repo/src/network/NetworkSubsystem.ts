import EventEmitter from "eventemitter3"

export type PeerId = string & { __peerId: false }
export type ChannelId = string & { __channelId: false }

interface AdapterOpenDetails {
  network: NetworkAdapter
}
interface PeerCandidateDetails {
  peerId: PeerId
  channelId: ChannelId
  connection: NetworkConnection
}

interface PeerDetails {
  peerId: PeerId
  channelId: ChannelId
}

export interface NetworkMessageDetails {
  peerId: PeerId
  channelId: ChannelId
  message: Uint8Array
}

interface DisconnectedDetails {
  peerId: PeerId
}

export interface NetworkAdapterEvents {
  open: (event: AdapterOpenDetails) => void
  "peer-candidate": (event: PeerCandidateDetails) => void
  "peer-disconnected": (event: DisconnectedDetails) => void
  message: (event: NetworkMessageDetails) => void
}

export interface NetworkEvents {
  peer: (msg: PeerDetails) => void
  message: (msg: NetworkMessageDetails) => void
}

export interface NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId // hmmm, maybe not
  connect(url?: string): void
  join(channelId: ChannelId): void
  leave(channelId: ChannelId): void
}

export interface DecodedMessage {
  type: string
  senderId: PeerId
  channelId: ChannelId
  data: Uint8Array
}

export interface NetworkConnection {
  isOpen(): boolean
  close(): void
  send(channelId: ChannelId, msg: Uint8Array): void
}

export class NetworkSubsystem extends EventEmitter<NetworkEvents> {
  networkAdapters: NetworkAdapter[] = []

  myPeerId: PeerId
  peers: { [peerId: PeerId]: NetworkConnection } = {}
  channels: ChannelId[]

  constructor(networkAdapters: NetworkAdapter[], peerId?: PeerId) {
    super()
    this.myPeerId =
      peerId || (`user-${Math.round(Math.random() * 100000)}` as PeerId)
    console.log("[NetworkSubsystem] local peerID: ", this.myPeerId)

    this.channels = []

    this.networkAdapters = networkAdapters
    networkAdapters.forEach((a) => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter: NetworkAdapter) {
    networkAdapter.connect(this.myPeerId)
    networkAdapter.on("peer-candidate", ({ peerId, channelId, connection }) => {
      if (!this.peers[peerId] || !this.peers[peerId].isOpen()) {
        this.peers[peerId] = connection
      }

      this.emit("peer", { peerId, channelId })
    })

    networkAdapter.on("message", (msg) => {
      this.emit("message", msg)
    })

    this.channels.forEach((c) => networkAdapter.join(c))
  }

  sendMessage(peerId: PeerId, channelId: ChannelId, message: Uint8Array) {
    if (peerId === "*") {
      Object.values(this.peers).forEach((peer) => peer.send(channelId, message))
    } else {
      const peer = this.peers[peerId]
      peer.send(channelId, message)
    }
  }

  join(channelId: ChannelId) {
    this.channels.push(channelId)
    this.networkAdapters.forEach((a) => a.join(channelId))
  }

  leave(channelId: ChannelId) {
    this.channels = this.channels.filter((c) => c !== channelId)
    this.networkAdapters.forEach((a) => a.leave(channelId))
  }
}
