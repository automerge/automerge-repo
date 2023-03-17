import {
  AuthenticateFn,
  authenticationError,
  AuthenticationResult,
  AUTHENTICATION_VALID,
} from "../../src/auth/AuthProvider.js"
import { GenerousAuthProvider } from "../../src/auth/GenerousAuthProvider.js"

const challenge = "what is the password?"

/** Just an example... not for production use */
export class DummyPasswordAuthProvider extends GenerousAuthProvider {
  constructor(private password: string) {
    super()
  }
  authenticate: AuthenticateFn = async (peerId, channel) => {
    return new Promise<AuthenticationResult>(resolve => {
      // challenge
      channel.send(new TextEncoder().encode(challenge))

      channel.on("message", ({ message }) => {
        const text = new TextDecoder().decode(message)
        if (text === challenge) {
          channel.send(new TextEncoder().encode(this.password))
        } else if (text === this.password) {
          resolve(AUTHENTICATION_VALID)
        } else {
          resolve(authenticationError("that is not the password"))
        }
      })
    })
  }
}
