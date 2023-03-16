import { ALWAYS, AuthProvider, VALID } from "./AuthProvider"

/** Anything goes */
export class GenerousAuthProvider extends AuthProvider {
  authenticate = async () => VALID
  okToAdvertise = ALWAYS
  okToSend = ALWAYS
  okToReceive = ALWAYS
}
