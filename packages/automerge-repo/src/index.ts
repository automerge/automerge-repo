export { DocHandle, HandleState } from "./DocHandle.js"
export type { DocHandleChangePayload } from "./DocHandle.js"
export { NetworkAdapter } from "./network/NetworkAdapter.js"
export type {
  OpenPayload,
  PeerCandidatePayload,
  PeerDisconnectedPayload,
} from "./network/NetworkAdapter.js"

// This is a bit confusing right now, but:
// Message is the type for messages used outside of the network adapters
// there are some extra internal network adapter-only messages on NetworkAdapterMessage
// and Message is (as of this writing) a union type for EphmeralMessage and SyncMessage
export type {
  Message,
  NetworkAdapterMessage,
  EphemeralMessage,
  SyncMessage,
} from "./network/messages.js"
export { isValidMessage } from "./network/messages.js"

export { NetworkSubsystem } from "./network/NetworkSubsystem.js"
export { Repo, type SharePolicy } from "./Repo.js"
export { StorageAdapter, type StorageKey } from "./storage/StorageAdapter.js"
export { StorageSubsystem } from "./storage/StorageSubsystem.js"
export { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"
export {
  parseAutomergeUrl,
  isValidAutomergeUrl,
  stringifyAutomergeUrl as generateAutomergeUrl,
} from "./DocUrl.js"
export * from "./types.js"

export * as cbor from "./helpers/cbor.js"
