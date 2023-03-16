import { ALWAYS, AuthProvider, NEVER, VALID } from "./AuthProvider"

/** Just like the GenerousAuthProvider, but doesn't advertise anything */
export class SyncServerAuthProvider extends AuthProvider {
  authenticate = async () => VALID
  okToAdvertise = NEVER
  okToSend = ALWAYS
  okToReceive = ALWAYS
}
