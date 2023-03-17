import { ALWAYS, AuthenticateFn, AuthProvider, VALID } from "./AuthProvider"

/** Anything goes */
export class GenerousAuthProvider extends AuthProvider {
  authenticate = (async () => VALID) as AuthenticateFn
  okToAdvertise = ALWAYS
  okToSend = ALWAYS
  okToReceive = ALWAYS
}
