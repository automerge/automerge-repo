import { DocumentId, PeerId } from "../types.js"
import { AuthChannel } from "./AuthChannel.js"

// PROVIDER

export interface AuthProviderConfig {
  authenticate?: AuthenticateFn
  transform?: Transform
  okToAdvertise?: SharePolicy
  okToSync?: SharePolicy
}

export type AuthProviderEvents = {
  "storage-available": () => void
}

// AUTHENTICATION

/**
 * An authentication function takes a peer ID and a channel with which to communicate with that peer.
 * @returns a promise of an `AuthenticationResult` object indicating whether authentication
 * succeeded, and, if not, why.
 */
export type AuthenticateFn = (
  /** ID of the remote peer. */
  peerId: PeerId,

  /** The provider implementation might use the provided channel to communicate with the peer. */
  channel: AuthChannel
) => Promise<AuthenticationResult>

export type ValidAuthenticationResult = {
  isValid: true
}

export type InvalidAuthenticationResult = {
  isValid: false
  error: Error
}

export type AuthenticationResult =
  | ValidAuthenticationResult
  | InvalidAuthenticationResult

// TRANSFORMATION

/** A Transform consists of two functions, for transforming inbound and outbound messages, respectively. */
export type Transform = {
  inbound: MessageTransformer
  outbound: MessageTransformer
}

export type MessageTransformer = (msg: any) => any

// AUTHORIZATION

/**
 * A SharePolicy takes a peer ID and optionally a document ID and returns true if the peer is
 * authorized to access the document.
 */
export type SharePolicy = (
  peerId: PeerId,
  documentId?: DocumentId
) => Promise<boolean>

