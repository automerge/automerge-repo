import {
  ALWAYS_OK,
  AuthenticateFn,
  AuthProvider,
  SharePolicy,
  AUTHENTICATION_VALID,
} from "../../src/auth/AuthProvider"

export class DummyAuthProvider extends AuthProvider {
  okToSend = ALWAYS_OK
  okToReceive = ALWAYS_OK

  constructor({
    authenticate,
    sharePolicy,
  }: {
    authenticate?: AuthenticateFn
    sharePolicy?: SharePolicy
  }) {
    super()
    this.authenticate = authenticate || (async () => AUTHENTICATION_VALID)
    this.okToAdvertise = sharePolicy || ALWAYS_OK
  }
}
