import { AuthProvider } from "./AuthProvider.js"
import { NEVER_OK } from "./constants.js"

/** Just like the base AuthProvider, but doesn't advertise anything */
export class SyncServerAuthProvider extends AuthProvider {
  okToAdvertise = NEVER_OK
}
