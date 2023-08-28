import { NetworkAdapter } from "../../src/index.js"

export class DummyNetworkAdapter extends NetworkAdapter {
  #startReady = true
  constructor(startReady: boolean) {
    super()
    this.#startReady = startReady
  }
  send() {}
  connect(_: string) {
    if (this.#startReady) {
      this.emit("ready", { network: this })
    }
  }
  join() {}
  leave() {}
}
