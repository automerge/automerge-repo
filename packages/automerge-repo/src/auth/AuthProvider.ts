import { DocumentId, PeerId } from "../types.js"
import { AuthChannel } from "./AuthChannel"

export abstract class AuthProvider {
  /** Can this peer prove their identity? */
  authenticate: AuthenticateFn = async () => NOT_IMPLEMENTED

  /** Should we tell this peer about the existence of this document? */
  okToAdvertise: SharePolicy = NEVER_OK

  /** Should we provide this document (and changes to it) to this peer when asked for it by ID? */
  okToSend: SharePolicy = NEVER_OK

  /**
   * Should we accept changes to this document from this peer?
   *
   * Note: This isn't useful for authorization, since the peer might be passing on changes authored
   * by someone else. In most cases this will just return `true` (since by that point the peer has
   * been authenticated).
   */
  okToReceive: SharePolicy = NEVER_OK
}

// helper

export const authenticationError = (msg: string) => ({
  isValid: false,
  error: new Error(msg),
})

// types

export type ValidAuthenticationResult = {
  isValid: true

  /**
   * An AuthProvider can optionally return a channel that the Repo should use for subsequent
   * communication with this peer. (For example, in localfirst/auth two peers negotiate a shared
   * secret and and use that to create an encrypted channel.)
   */
  channel?: AuthChannel
}

export type InvalidAuthenticationResult = {
  isValid: false
  error: Error
}

export type AuthenticationResult =
  | ValidAuthenticationResult
  | InvalidAuthenticationResult

export type AuthenticateFn = (
  /** ID of the remote peer. */
  peerId: PeerId,
  /** The provider implementation will use the provided channel to communicate with the peer. */
  channel: AuthChannel
) => Promise<AuthenticationResult>

export type SharePolicy = (
  peerId: PeerId,
  documentId?: DocumentId
) => Promise<boolean>

// constants

export const AUTHENTICATION_VALID: ValidAuthenticationResult = { isValid: true }

export const ALWAYS_OK: SharePolicy = async () => true
export const NEVER_OK: SharePolicy = async () => false

const NOT_IMPLEMENTED = authenticationError("not implemented")
