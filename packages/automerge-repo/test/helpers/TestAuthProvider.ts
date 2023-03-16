import {
  ALWAYS,
  AuthenticateFn,
  AuthProvider,
  SharePolicy,
  VALID,
} from "../../src/auth/AuthProvider"

export class TestAuthProvider extends AuthProvider {
  okToSend = ALWAYS
  okToReceive = ALWAYS

  constructor({
    authenticate,
    sharePolicy,
  }: {
    authenticate?: AuthenticateFn
    sharePolicy?: SharePolicy
  }) {
    super()
    this.authenticate = authenticate || (async () => VALID)
    this.okToAdvertise = sharePolicy || ALWAYS
  }
}
