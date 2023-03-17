import EventEmitter from "eventemitter3"
import { InboundMessagePayload } from "../network/NetworkAdapter.js"
import { DocumentId, PeerId } from "../types.js"

export abstract class AuthProvider {
  /** Can this peer prove their identity? */
  authenticate: AuthenticateFn = async () => NOT_IMPLEMENTED

  /** Should we tell this peer about the existence of this document? */
  okToAdvertise: SharePolicy = NEVER

  /** Should we provide this document (and changes to it) to this peer when asked for it by ID? */
  okToSend: SharePolicy = NEVER

  /**
   * Should we accept changes to this document from this peer?
   *
   * Note: This isn't useful for authorization, since the peer might be passing on changes authored
   * by someone else. In most cases this will just return `true` (since by that point the peer has
   * been authenticated).
   */
  okToReceive: SharePolicy = NEVER
}

export type ValidAuthenticationResult = {
  isValid: true

  /**
   * An AuthProvider can optionally return a channel that the Repo should use for subsequent
   * communication with this peer. (For example, in localfirst/auth two peers negotiate a shared
   * secret and and use that to create an encrypted channel.)
   */
  channel?: WebSocket
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
  socket?: AuthChannel
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

export class AuthChannel extends EventEmitter<AuthChannelEvents> {
  constructor(public send: (message: Uint8Array) => void) {
    super()
  }
}

export interface AuthChannelEvents {
  message: (payload: InboundMessagePayload) => void
}
