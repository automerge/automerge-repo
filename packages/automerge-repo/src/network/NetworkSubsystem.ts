import EventEmitter from "eventemitter3"

import debug from "debug"
const log = debug("NetworkSubsystem")

export type PeerId = string & { __peerId: false }
export type ChannelId = string & { __channelId: false }

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
  targetId: PeerId
  channelId: ChannelId
  message: Uint8Array
  broadcast: boolean
}

export interface InboundMessageDetails extends OutboundMessageDetails {
  senderId: PeerId
}

interface DisconnectedDetails {
  peerId: PeerId
}

export interface NetworkAdapterEvents {
  open: (event: AdapterOpenDetails) => void
  close: () => void
  "peer-candidate": (event: PeerCandidateDetails) => void
  "peer-disconnected": (event: DisconnectedDetails) => void
  message: (event: InboundMessageDetails) => void
}

export interface NetworkEvents {
  peer: (msg: PeerDetails) => void
  "peer-disconnected": (event: DisconnectedDetails) => void
  message: (msg: InboundMessageDetails) => void
}

export interface NetworkAdapter extends EventEmitter<NetworkAdapterEvents> {
  peerId?: PeerId // hmmm, maybe not
  connect(url?: string): void
  sendMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array,
    broadcast: boolean
  ): void
  join(channelId: ChannelId): void
  leave(channelId: ChannelId): void
}

export interface DecodedMessage {
  type: string
  senderId: PeerId
  targetId: PeerId
  channelId: ChannelId
  data: Uint8Array
  broadcast: boolean
}

export interface Peer extends EventEmitter<InboundMessageDetails> {
  isOpen(): boolean
  close(): void
  send(channelId: ChannelId, msg: Uint8Array): void
}

export class NetworkSubsystem extends EventEmitter<NetworkEvents> {
  networkAdapters: NetworkAdapter[] = []
  authProvider?: AuthProvider

  myPeerId: PeerId
  peerIdToAdapter: { [peerId: PeerId]: NetworkAdapter } = {}
  channels: ChannelId[]

  constructor(
    networkAdapters: NetworkAdapter[],
    authProvider: AuthProvider,
    peerId?: PeerId
  ) {
    super()
    this.myPeerId =
      peerId || (`user-${Math.round(Math.random() * 100000)}` as PeerId)
    log("local peerID: ", this.myPeerId)

    this.channels = []

    this.networkAdapters = networkAdapters
    networkAdapters.forEach(a => this.addNetworkAdapter(a))
  }

  addNetworkAdapter(networkAdapter: NetworkAdapter) {
    networkAdapter.connect(this.myPeerId)
    // this code isn't very thoughtful about what to do if we have more than one connection
    // or how to reestablish a connection we lose
    networkAdapter.on("peer-candidate", ({ peerId, channelId }) => {
      if (!this.peerIdToAdapter[peerId]) {
        // TODO: we don't actually have a socket, we want to be able to send & receive
        //       messages from an unauthenticated peer over a network adapter
        const authenticated = await this.authProvider.authenticate(
          peerId,
          socket
        )
        if (authenticated) {
          // channelID????
          this.peerIdToAdapter[peerId] = networkAdapter
        } else {
          throw new Error("Peer candidate failed authentication.")
        }
      }

      this.emit("peer", { peerId, channelId })
    })
    networkAdapter.on("peer-disconnected", ({ peerId }) => {
      delete this.peerIdToAdapter[peerId]
      this.emit("peer-disconnected", { peerId })
    })

    networkAdapter.on("message", msg => {
      const { senderId, targetId, channelId, broadcast, message } = msg
      // If we receive a broadcast message from a network adapter
      // we need to re-broadcast it to all our other peers.
      // This is the world's worst gossip protocol.
      // TODO: This relies on the network forming a tree!
      //       If there are cycles, this approach will loop messages around forever.
      if (broadcast) {
        Object.entries(this.peerIdToAdapter)
          .filter(([id]) => id !== senderId)
          .forEach(([id, adapter]) => {
            adapter.sendMessage(id as PeerId, channelId, message, broadcast)
          })
      }

      this.emit("message", msg)
    })

    networkAdapter.on("close", () => {
      Object.entries(this.peerIdToAdapter).forEach(([peerId, other]) => {
        if (other === networkAdapter) {
          delete this.peerIdToAdapter[peerId as PeerId]
        }
      })
    })

    this.channels.forEach(c => networkAdapter.join(c))
  }

  sendMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array,
    broadcast: boolean
  ) {
    if (broadcast) {
      Object.entries(this.peerIdToAdapter).forEach(([id, peer]) => {
        peer.sendMessage(id as PeerId, channelId, message, true)
      })
    } else {
      const adapter = this.peerIdToAdapter[peerId]
      if (!adapter) {
        log(`Tried to send message to disconnected peer: ${peerId}`)
        return
      }
      adapter.sendMessage(peerId, channelId, message, false)
    }
  }

  join(channelId: ChannelId) {
    this.channels.push(channelId)
    this.networkAdapters.forEach(a => a.join(channelId))
  }

  leave(channelId: ChannelId) {
    this.channels = this.channels.filter(c => c !== channelId)
    this.networkAdapters.forEach(a => a.leave(channelId))
  }
}
