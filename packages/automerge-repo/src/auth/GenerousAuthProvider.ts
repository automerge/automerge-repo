import {
  ALWAYS_OK,
  AuthenticateFn,
  AuthProvider,
  AUTHENTICATION_VALID,
} from "./AuthProvider"

/** Anything goes */
export class GenerousAuthProvider extends AuthProvider {
  authenticate = (async () => AUTHENTICATION_VALID) as AuthenticateFn
  okToAdvertise = ALWAYS_OK
  okToSend = ALWAYS_OK
  okToReceive = ALWAYS_OK
}
