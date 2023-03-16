import { DocumentId, PeerId } from "../types.js"

export abstract class AuthProvider {
  /** Can this peer prove their identity? */
  authenticate: AuthenticateFn = async () => NOT_IMPLEMENTED

  /** Should we tell this peer about the existence of this document? */
  okToAdvertise: SharePolicy = NEVER

  /** Should we provide this document (and changes to it) to this peer when asked for it by ID? */
  okToSend: SharePolicy = NEVER

  /** Should we accept changes to this document from this peer? */
  okToReceive: SharePolicy = NEVER
}

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

export const VALID: ValidAuthenticationResult = { isValid: true }

export type AuthenticateFn = (
  /** ID of the remote peer. */
  peerId: PeerId,
  /** The provider implementation will use the provided socket to communicate with the peer. */
  socket?: WebSocket
) => Promise<AuthenticationResult>

export type SharePolicy = (
  peerId: PeerId,
  documentId?: DocumentId
) => Promise<boolean>

export const ALWAYS: SharePolicy = async () => true
export const NEVER: SharePolicy = async () => false

const NOT_IMPLEMENTED: InvalidAuthenticationResult = {
  isValid: false,
  error: new Error("Not implemented"),
}
