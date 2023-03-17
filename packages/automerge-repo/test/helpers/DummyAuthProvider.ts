import {
  ALWAYS_OK,
  AuthProvider,
  IDENTITY_WRAPPER,
  NetworkAdapterWrapper,
  SharePolicy,
} from "../../src/auth/AuthProvider"

export class DummyAuthProvider extends AuthProvider {
  okToSend = ALWAYS_OK
  okToReceive = ALWAYS_OK

  constructor({
    wrapNetworkAdapter,
    sharePolicy,
  }: {
    wrapNetworkAdapter?: NetworkAdapterWrapper
    sharePolicy?: SharePolicy
  }) {
    super()
    this.wrapNetworkAdapter = wrapNetworkAdapter || IDENTITY_WRAPPER
    this.okToAdvertise = sharePolicy || ALWAYS_OK
  }
}
