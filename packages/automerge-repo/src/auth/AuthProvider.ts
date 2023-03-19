import { forwardEvents } from "../helpers/forwardEvents"
import {
  InboundMessagePayload,
  MessagePayload,
  NetworkAdapter,
} from "../network/NetworkAdapter"
import { ChannelId, DocumentId, PeerId } from "../types.js"
import { AuthChannel } from "./AuthChannel"

/**
 * An AuthProvider is responsible for authentication (proving that a peer is who they say they are)
 * and authorization (deciding whether a peer is allowed to access a document).
 *
 * By default, an AuthProvider is maximally permissive: it allows any peer to access any document.
 *
 * An AuthProvider can be configured by passing a config object to the constructor, or by extending
 * the class and overriding methods.
 */
export class AuthProvider {
  /** Is this peer who they say they are? */
  authenticate: AuthenticateFn = async () => AUTHENTICATION_VALID

  /**
   * An AuthProvider can optionally transform incoming and outgoing messages. For example,
   * authentication might involve encrypting and decrypting messages using a shared secret.
   *
   * By default, messages are not transformed.
   */
  transform: Transform = { inbound: p => p, outbound: p => p }

  /** Should we tell this peer about the existence of this document? */
  okToAdvertise: SharePolicy = ALWAYS_OK

  /** Should we provide this document (and changes to it) to this peer when asked for it by ID? */
  okToSend: SharePolicy = ALWAYS_OK

  constructor(config: AuthProviderConfig = {}) {
    return Object.assign(this, config)
  }

  /**
   * The repo uses the AuthProvider to wrap each network adapter in order to authenticate new peers
   * and transform inbound and outbound messages.
   * @param baseAdapter
   * @returns
   */
  wrapNetworkAdapter = (baseAdapter: NetworkAdapter) => {
    const authenticate = this.authenticate
    const transform = this.transform

    const wrappedAdapter = new WrappedAdapter(baseAdapter, transform)

    // try to authenticate new peers; if we succeed, we forward the peer-candidate event
    baseAdapter.on("peer-candidate", async ({ peerId, channelId }) => {
      const channel = new AuthChannel(baseAdapter, peerId)
      const authResult = await authenticate(peerId, channel)

      if (authResult.isValid) {
        wrappedAdapter.emit("peer-candidate", { peerId, channelId })
      } else {
        const { error } = authResult
        wrappedAdapter.emit("error", { peerId, channelId, error })
      }
    })

    // transform incoming messages
    baseAdapter.on("message", payload => {
      try {
        const transformedPayload = transform.inbound(payload)
        wrappedAdapter.emit("message", transformedPayload)
      } catch (e) {
        wrappedAdapter.emit("error", {
          peerId: payload.senderId,
          channelId: payload.channelId,
          error: e as Error,
        })
      }
    })

    // forward all other events
    forwardEvents(baseAdapter, wrappedAdapter, [
      "open",
      "close",
      "peer-disconnected",
      "error",
    ])

    return wrappedAdapter
  }
}

// HELPERS

/**
 * A WrappedAdapter is a NetworkAdapter that wraps another NetworkAdapter and
 * transforms outbound messages.
 */
class WrappedAdapter extends NetworkAdapter {
  constructor(
    private baseAdapter: NetworkAdapter,
    private transform: Transform
  ) {
    super()
  }

  // passthrough methods
  connect = (url?: string) => this.baseAdapter.connect(url)
  join = (channelId: ChannelId) => this.baseAdapter.join(channelId)
  leave = (channelId: ChannelId) => this.baseAdapter.leave(channelId)
  sendMessage = (
    targetId: PeerId,
    channelId: ChannelId,
    message: Uint8Array,
    broadcast: boolean
  ) => {
    const transformedPayload = this.transform.outbound({
      targetId,
      channelId,
      message,
      broadcast,
    })
    this.baseAdapter.sendMessage(
      transformedPayload.targetId,
      transformedPayload.channelId,
      transformedPayload.message,
      transformedPayload.broadcast
    )
  }
}

export const authenticationError = (msg: string) => ({
  isValid: false,
  error: new Error(msg),
})

// TYPES

export interface AuthProviderConfig {
  authenticate?: AuthenticateFn
  transform?: Transform
  okToAdvertise?: SharePolicy
  okToSend?: SharePolicy
}

// authentication

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

export type AuthenticateFn = (
  /** ID of the remote peer. */
  peerId: PeerId,
  /** The provider implementation will use the provided channel to communicate with the peer. */
  channel: AuthChannel
) => Promise<AuthenticationResult>

// transformation

export type Transform = {
  inbound: (p: InboundMessagePayload) => InboundMessagePayload
  outbound: (p: MessagePayload) => MessagePayload
}

// authorization

export type SharePolicy = (
  peerId: PeerId,
  documentId?: DocumentId
) => Promise<boolean>

// CONSTANTS

export const AUTHENTICATION_VALID: ValidAuthenticationResult = { isValid: true }

export const ALWAYS_OK: SharePolicy = async () => true
export const NEVER_OK: SharePolicy = async () => false
