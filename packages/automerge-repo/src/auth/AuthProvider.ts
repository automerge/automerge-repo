import { NetworkAdapter } from "../network/NetworkAdapter"
import { ChannelId, DocumentId, PeerId } from "../types.js"
import { AuthChannel } from "./AuthChannel"

/**
 * An AuthProvider is responsible for authentication (proving that a peer is who they say they are)
 * and authorization (deciding whether a peer is allowed to access a document).
 *
 * This abstract class must be extended to provide a concrete implementation.
 */
export abstract class AuthProvider {
  /**
   * Can this peer prove their identity?
   *
   * An AuthProvider must implement this method to provide authentication.
   */
  authenticate: AuthenticateFn = async () => NOT_IMPLEMENTED

  /**
   * An AuthProvider can optionally implement this method to intercept messages sent and received by
   * the network adapter.
   */
  wrapNetworkAdapter: NetworkAdapterWrapper = baseAdapter => {
    const authenticate = this.authenticate

    class WrappedAdapter extends NetworkAdapter {
      connect = (url?: string) => baseAdapter.connect(url)

      sendMessage = (
        peerId: PeerId,
        channelId: ChannelId,
        message: Uint8Array,
        broadcast: boolean
      ) => {
        // this is where we could encrypt the message or whatever
        baseAdapter.sendMessage(peerId, channelId, message, broadcast)
      }

      join = (channelId: ChannelId) => baseAdapter.join(channelId)
      leave = (channelId: ChannelId) => baseAdapter.leave(channelId)
    }
    const wrappedAdapter = new WrappedAdapter()

    // when the baseAdapter emits a new peer, we try to authenticate them.
    // If we succeed, then we forward the peer-candidate event
    baseAdapter.on("peer-candidate", async ({ peerId, channelId }) => {
      const channel = new AuthChannel(baseAdapter, peerId)
      const authResult = await authenticate(peerId, channel)

      if (authResult.isValid) {
        wrappedAdapter.emit("peer-candidate", { peerId, channelId })
      } else {
        const { error } = authResult
        wrappedAdapter.emit("error", { peerId, channelId, error })
      }

      // Note that some adapters might want to leave the channel open here, e.g. in case the peer's
      // authentication is revoked
      channel.close()
    })

    // when the base adapter gets a new message, we forward it as-is
    baseAdapter.on("message", payload => {
      // this is where we could decrypt the message or whatever
      wrappedAdapter.emit("message", payload)
    })

    return wrappedAdapter
  }

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

export type NetworkAdapterWrapper = (
  networkAdapter: NetworkAdapter
) => NetworkAdapter

export type SharePolicy = (
  peerId: PeerId,
  documentId?: DocumentId
) => Promise<boolean>

// constants

export const AUTHENTICATION_VALID: ValidAuthenticationResult = { isValid: true }

export const ALWAYS_OK: SharePolicy = async () => true
export const NEVER_OK: SharePolicy = async () => false

export const IDENTITY_WRAPPER: NetworkAdapterWrapper = adapter => adapter
const NOT_IMPLEMENTED = authenticationError("not implemented")
