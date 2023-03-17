import {
  ALWAYS_OK,
  AuthProvider,
  NEVER_OK,
  AUTHENTICATION_VALID,
} from "./AuthProvider"

/** Just like the GenerousAuthProvider, but doesn't advertise anything */
export class SyncServerAuthProvider extends AuthProvider {
  authenticate = async () => AUTHENTICATION_VALID
  okToAdvertise = NEVER_OK
  okToSend = ALWAYS_OK
  okToReceive = ALWAYS_OK
}
