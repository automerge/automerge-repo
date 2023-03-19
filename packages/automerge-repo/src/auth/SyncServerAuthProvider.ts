import { AuthProvider, NEVER_OK } from "./AuthProvider"

/** Just like the base AuthProvider, but doesn't advertise anything */
export class SyncServerAuthProvider extends AuthProvider {
  okToAdvertise = NEVER_OK
}
