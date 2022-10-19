import EventEmitter from "eventemitter3"

export type PeerId = string & { __peerId: false }
export type ChannelId = string & { __channelId: false }

interface PeerCandidateDetails {
  peerId: PeerId
  channelId: ChannelId
  connection: NetworkConnection
}

interface PeerDetails {
  peerId: PeerId
  channelId: ChannelId
}

interface MessageDetails {
  senderId: PeerId
  channelId: ChannelId
  message: Uint8Array
}

interface DisconnectedDetails {
  peerId: PeerId
}

export interface NetworkAdapterEvents {
  "peer-candidate": (event: PeerCandidateDetails) => void
  "peer-disconnected": (event: DisconnectedDetails) => void
  message: (event: MessageDetails) => void
}

export interface NetworkEvents {
  peer: (msg: PeerDetails) => void
  message: (msg: MessageDetails) => void
}

export interface NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId // hmmm, maybe not
  connect(clientId: PeerId): void
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
  send(msg: Uint8Array): void
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
    console.log("we are peer id", this.myPeerId)

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

  onMessage(peerId: PeerId, message: Uint8Array) {
    const peer = this.peers[peerId]
    peer.send(message)
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
