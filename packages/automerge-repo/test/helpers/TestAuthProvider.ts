import {
  ALWAYS,
  AuthProvider,
  SharePolicy,
  VALID,
} from "../../src/auth/AuthProvider"

export class TestAuthProvider extends AuthProvider {
  authenticate = async () => VALID
  okToAdvertise: SharePolicy
  okToSend = ALWAYS
  okToReceive = ALWAYS

  constructor(sharePolicy: SharePolicy) {
    super()
    this.okToAdvertise = sharePolicy
  }
}
