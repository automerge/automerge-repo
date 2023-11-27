import { NetworkAdapter, RepoMessage } from "@automerge/automerge-repo"
import { eventPromise } from "./eventPromise.js"

/**
 * An AuthenticatedNetworkAdapter is a NetworkAdapter that wraps another NetworkAdapter and
 * transforms outbound messages.
 */
export class AuthenticatedNetworkAdapter<T extends NetworkAdapter> //
  extends NetworkAdapter
{
  connect: typeof NetworkAdapter.prototype.connect
  disconnect: typeof NetworkAdapter.prototype.disconnect

  #isReady: boolean = false

  send = (msg: RepoMessage) => {
    // wait for base adapter to be ready
    if (!this.#isReady) {
      eventPromise(this.baseAdapter, "ready") //
        .then(() => this.sendFn(msg))
    } else {
      // send immediately
      this.sendFn(msg)
    }
  }

  /**
   * The LocalFirstAuthProvider wraps a NetworkAdapter
   * @param baseAdapter
   * @param send
   */
  constructor(
    public baseAdapter: T,
    private sendFn: (msg: RepoMessage) => void
  ) {
    super()

    // pass through the base adapter's connect & disconnect methods
    this.connect = this.baseAdapter.connect.bind(this.baseAdapter)
    this.disconnect = this.baseAdapter.disconnect.bind(this.baseAdapter)

    baseAdapter.on("ready", () => {
      this.#isReady = true
    })
  }
}
