import {
  AuthenticateFn,
  authenticationError,
  AuthenticationResult,
  AUTHENTICATION_VALID,
} from "../../src/auth/AuthProvider.js"
import { GenerousAuthProvider } from "../../src/auth/GenerousAuthProvider.js"

const CHALLENGE = "what is the password?"

const PASSWORDS_TOP_SECRET: Record<string, string> = {
  alice: "abracadabra",
  bob: "bucaramanga",
}

/**
 * This provider allows us to test the use of channels for implementing an authentication protocol.
 * This is not a good example of how to implement password authentication!!
 */
export class DummyPasswordAuthProvider extends GenerousAuthProvider {
  constructor(private password: string) {
    super()
  }
  authenticate: AuthenticateFn = async (peerId, channel) => {
    return new Promise<AuthenticationResult>(resolve => {
      // send challenge
      channel.send(new TextEncoder().encode(CHALLENGE))

      channel.on("message", msg => {
        const msgText = new TextDecoder().decode(msg)
        if (msgText === CHALLENGE) {
          // received challenge, send password
          channel.send(new TextEncoder().encode(this.password))
        } else if (msgText === PASSWORDS_TOP_SECRET[peerId]) {
          // received correct password
          resolve(AUTHENTICATION_VALID)
        } else {
          // received incorrect password
          resolve(authenticationError("that is not the password"))
        }
      })
    })
  }
}
