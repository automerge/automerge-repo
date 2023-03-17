import { PeerId } from "../../src/types"
import {
  ALWAYS,
  AuthChannel,
  AuthenticationResult,
  AuthProvider,
} from "../../src/auth/AuthProvider"

const challenge = "what is the password?"

/** Just an example... not for production use */
export class DummyPasswordAuthProvider extends AuthProvider {
  constructor(private password: string) {
    super()
  }
  authenticate = async (peerId: PeerId, socket?: AuthChannel) => {
    if (socket == null)
      return {
        isValid: false,
        error: new Error("I need a socket"),
      }

    return new Promise<AuthenticationResult>(resolve => {
      // challenge
      socket.send(new TextEncoder().encode(challenge))

      socket.on("message", ({ message }) => {
        const text = new TextDecoder().decode(message)
        if (text == challenge) {
          socket.send(new TextEncoder().encode(this.password))
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
  okToAdvertise = ALWAYS
  okToSend = ALWAYS
  okToReceive = ALWAYS
}
