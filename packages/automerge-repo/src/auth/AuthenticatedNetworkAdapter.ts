import { RepoMessage, isValidRepoMessage } from "../index.js"
import { NetworkAdapter } from "../network/NetworkAdapter.js"
import { Transform } from "./types.js"

/**
 * An AuthenticatedNetworkAdapter is a NetworkAdapter that wraps another NetworkAdapter and
 * transforms outbound messages.
 */
export class AuthenticatedNetworkAdapter<T extends NetworkAdapter> //
  extends NetworkAdapter
{
  baseAdapter: T
  transform: Transform

  connect: typeof NetworkAdapter.prototype.connect
  disconnect: typeof NetworkAdapter.prototype.disconnect

  constructor(baseAdapter: T, transform: Transform) {
    super()
    this.baseAdapter = baseAdapter
    this.transform = transform

    // pass through the base adapter's connect & disconnect methods
    this.connect = this.baseAdapter.connect.bind(this.baseAdapter)
    this.disconnect = this.baseAdapter.disconnect.bind(this.baseAdapter)
  }

  // transform outgoing messages
  send = (message: RepoMessage) => {
    this.baseAdapter.send(this.transform.outbound(message))
  }
}
