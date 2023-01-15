import * as Automerge from "@automerge/automerge"
import EventEmitter from "eventemitter3"
import { DocHandle } from "./DocHandle"

export type DocumentId = string & { __documentId: true }
export type PeerId = string & { __peerId: false }
export type ChannelId = string & { __channelId: false }

export const HandleState = {
  LOADING: "LOADING",
  SYNCING: "SYNCING",
  READY: "READY",
} as const

// avoiding enum https://maxheiber.medium.com/alternatives-to-typescript-enums-50e4c16600b1
export type HandleState = typeof HandleState[keyof typeof HandleState]

export interface DocHandleMessageEvent {
  destinationId: PeerId
  channelId: ChannelId
  data: Uint8Array
}

export interface DocHandleChangeEvent<T> {
  handle: DocHandle<T>
}

export interface DocHandlePatchEvent<T> {
  handle: DocHandle<T>
  patch: any // Automerge.Patch
  before: Automerge.Doc<T>
  after: Automerge.Doc<T>
}

export interface DocHandleEvents<T> {
  syncing: () => void // HMM
  ready: () => void // HMM
  message: (event: DocHandleMessageEvent) => void
  change: (event: DocHandleChangeEvent<T>) => void
  patch: (event: DocHandlePatchEvent<T>) => void
}

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
