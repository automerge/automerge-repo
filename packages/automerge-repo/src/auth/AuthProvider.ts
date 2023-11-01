import { EventEmitter } from "eventemitter3"
import { forwardEvents } from "../helpers/forwardEvents.js"
import { SharePolicy } from "../index.js"
import { NetworkAdapter } from "../network/NetworkAdapter.js"
import { AuthChannel } from "./AuthChannel.js"
import { AuthenticatedNetworkAdapter } from "./AuthenticatedNetworkAdapter.js"
import { ALWAYS_OK, AUTHENTICATION_VALID } from "./constants.js"
import {
  AuthProviderConfig,
  AuthProviderEvents,
  AuthenticateFn,
  MessageTransformer,
  Transform,
} from "./types.js"
import { StorageSubsystem } from "../storage/StorageSubsystem.js"

/**
 * An AuthProvider is responsible for authentication (proving that a peer is who they say they are)
 * and authorization (deciding whether a peer is allowed to access a document).
 *
 * By default, an AuthProvider is maximally permissive: it allows any peer to access any document.
 *
 * An AuthProvider can be configured by passing a config object to the constructor, or by extending
 * the class and overriding methods.
 */
export class AuthProvider<T extends AuthProviderEvents = any>
  extends EventEmitter<T | AuthProviderEvents>
{
  private storage: StorageSubsystem | undefined

  constructor(config: AuthProviderConfig = {}) {
    super()
    return Object.assign(this, config)
  }

  /** Is this peer who they say they are? */
  authenticate: AuthenticateFn = async () => AUTHENTICATION_VALID

  /** Should we tell this peer about the existence of this document? */
  okToAdvertise: SharePolicy = ALWAYS_OK

  /** Should we provide this document & changes to it if requested? */
  okToSync: SharePolicy = ALWAYS_OK

  /**
   * An AuthProvider can optionally transform incoming and outgoing messages. For example,
   * authentication might involve encrypting and decrypting messages using a shared secret.
   * By default, messages are not transformed.
   */
  transform: Transform = { inbound: NO_TRANSFORM, outbound: NO_TRANSFORM }

  /**
   * The repo uses the AuthProvider to wrap each network adapter in order to authenticate new peers
   * and transform inbound and outbound messages.
   * @param baseAdapter
   * @returns
   */
  wrapNetworkAdapter = (baseAdapter: NetworkAdapter) => {
    const authenticate = this.authenticate
    const transform = this.transform
    const wrappedAdapter = new AuthenticatedNetworkAdapter(
      baseAdapter,
      transform
    )

    // try to authenticate new peers; if we succeed, we forward the peer-candidate event
    baseAdapter.on("peer-candidate", async ({ peerId }) => {
      const channel = new AuthChannel(baseAdapter, peerId)
      const authResult = await authenticate(peerId, channel)

      if (authResult.isValid) {
        wrappedAdapter.emit("peer-candidate", { peerId })
      } else {
        const { error } = authResult
        wrappedAdapter.emit("error", { peerId, error })
      }
    })

    // forward all other events
    forwardEvents(baseAdapter, wrappedAdapter, [
      "ready",
      "close",
      "peer-disconnected",
      "error",
    ])

    return wrappedAdapter
  }

  useStorage = (storage: StorageSubsystem) => {
    this.storage = storage
    this.emit("storage-available")
  }

  hasStorage = () => this.storage !== undefined

  save = async (key: string, value: Uint8Array) => {
    if (this.storage === undefined)
      throw new Error("AuthProvider: no storage subsystem configured")
    await this.storage.save("AuthProvider", key, value)
  }

  load = async (key: string) => {
    if (this.storage === undefined)
      throw new Error("AuthProvider: no storage subsystem configured")
    return await this.storage.load("AuthProvider", key)
  }
}

export const authenticationError = (msg: string) => ({
  isValid: false,
  error: new Error(msg),
})

const NO_TRANSFORM: MessageTransformer = p => p

