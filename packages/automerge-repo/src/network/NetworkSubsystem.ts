import EventEmitter from "eventemitter3"

import debug from "debug"
const log = debug("NetworkSubsystem")

export type PeerId = string & { __peerId: false }
export type ChannelId = string & { __channelId: false }

export const ALL_PEERS_ID = "*" as PeerId

interface AdapterOpenDetails {
  network: NetworkAdapter
}
interface PeerCandidateDetails {
  peerId: PeerId
  channelId: ChannelId
}

interface PeerDetails {
  peerId: PeerId
  channelId: ChannelId
}

export interface OutboundMessageDetails {
  targetId: PeerId // * is a special value that indicates "all peers"
  channelId: ChannelId
  message: Uint8Array
}

export interface InboundMessageDetails extends OutboundMessageDetails {
  senderId: PeerId
}

interface DisconnectedDetails {
  peerId: PeerId
}

export interface NetworkAdapterEvents {
  open: (event: AdapterOpenDetails) => void
  "peer-candidate": (event: PeerCandidateDetails) => void
  "peer-disconnected": (event: DisconnectedDetails) => void
  message: (event: InboundMessageDetails) => void
}

export interface NetworkEvents {
  peer: (msg: PeerDetails) => void
  message: (msg: InboundMessageDetails) => void
}

export interface NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId // hmmm, maybe not
  connect(url?: string): void
  sendMessage(peerId: PeerId, channelId: ChannelId, message: Uint8Array): void
  join(channelId: ChannelId): void
  leave(channelId: ChannelId): void
}

export interface DecodedMessage {
  type: string
  senderId: PeerId
  targetId: PeerId
  channelId: ChannelId
  data: Uint8Array
}

export interface Peer extends EventEmitter<InboundMessageDetails> {
  isOpen(): boolean
  close(): void
  send(channelId: ChannelId, msg: Uint8Array): void
}

export class NetworkSubsystem extends EventEmitter<NetworkEvents> {
  networkAdapters: NetworkAdapter[] = []

  myPeerId: PeerId
  peers: { [peerId: PeerId]: NetworkAdapter } = {}
  channels: ChannelId[]

  constructor(networkAdapters: NetworkAdapter[], peerId?: PeerId) {
    super()
    this.myPeerId =
      peerId || (`user-${Math.round(Math.random() * 100000)}` as PeerId)
    log("local peerID: ", this.myPeerId)

    this.channels = []

    this.networkAdapters = networkAdapters
    networkAdapters.forEach((a) => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter: NetworkAdapter) {
    networkAdapter.connect(this.myPeerId)
    networkAdapter.on("peer-candidate", ({ peerId, channelId }) => {
      if (!this.peers[peerId]) {
        // TODO: handle losing a server here
        this.peers[peerId] = networkAdapter
      }

      this.emit("peer", { peerId, channelId })
    })

    networkAdapter.on("message", (msg) => {
      const { senderId, targetId, channelId, message } = msg
      if (targetId === ALL_PEERS_ID) {
        console.log("message for all peers, sending to", this.peers)
        Object.entries(this.peers)
          .filter(([id]) => id !== senderId)
          .forEach(([id, peer]) =>
            peer.sendMessage(targetId, channelId, message)
          )
      }
      this.emit("message", msg)
    })

    this.channels.forEach((c) => networkAdapter.join(c))
  }

  sendMessage(peerId: PeerId, channelId: ChannelId, message: Uint8Array) {
    if (peerId === ALL_PEERS_ID) {
      Object.entries(this.peers).forEach(
        ([id, peerAdapter]) =>
          peerAdapter.sendMessage(ALL_PEERS_ID, channelId, message) // TODO: this would lead to message duplication if we had N peers on an adapter
      )
    } else {
      const peer = this.peers[peerId]
      peer.sendMessage(peerId, channelId, message)
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
