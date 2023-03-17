import {
  AuthenticateFn,
  AuthenticationResult,
} from "../../src/auth/AuthProvider"
import { GenerousAuthProvider } from "../../src/auth/GenerousAuthProvider"

const challenge = "what is the password?"

/** Just an example... not for production use */
export class DummyPasswordAuthProvider extends GenerousAuthProvider {
  constructor(private password: string) {
    super()
  }
  authenticate: AuthenticateFn = async (peerId, channel?) => {
    if (channel === undefined)
      return {
        isValid: false,
        error: new Error("I need a socket"),
      }

    return new Promise<AuthenticationResult>(resolve => {
      // challenge
      channel.send(new TextEncoder().encode(challenge))

      channel.on("message", ({ message }) => {
        const text = new TextDecoder().decode(message)
        if (text == challenge) {
          channel.send(new TextEncoder().encode(this.password))
        } else if (text === this.password) {
          resolve({ isValid: true })
        } else {
          resolve({
            isValid: false,
            error: new Error("that is not the password"),
          })
        }
      })
    })
  }
}
