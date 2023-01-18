import * as Automerge from "@automerge/automerge"
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
