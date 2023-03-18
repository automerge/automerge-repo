export {
  AuthProvider,
  authenticationError,
  type ValidAuthenticationResult,
  type InvalidAuthenticationResult,
  type AuthenticateFn,
  type SharePolicy,
  AUTHENTICATION_VALID,
  ALWAYS_OK,
  NEVER_OK,
} from "./auth/AuthProvider.js"

export { DocCollection } from "./DocCollection.js"
export { DocHandle, HandleState } from "./DocHandle.js"
export type {
  DocHandleChangePayload,
  DocHandleMessagePayload,
  DocHandlePatchPayload,
} from "./DocHandle.js"
export { NetworkAdapter } from "./network/NetworkAdapter.js"
export type {
  InboundMessagePayload,
  MessagePayload,
  OpenPayload,
  PeerCandidatePayload,
  PeerDisconnectedPayload,
} from "./network/NetworkAdapter.js"
export { NetworkSubsystem } from "./network/NetworkSubsystem.js"
export { Repo } from "./Repo.js"
export { StorageAdapter } from "./storage/StorageAdapter.js"
export { StorageSubsystem } from "./storage/StorageSubsystem.js"
export { CollectionSynchronizer } from "./synchronizer/CollectionSynchronizer.js"
export * from "./types.js"
