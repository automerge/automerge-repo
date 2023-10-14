import { NetworkAdapter } from "../../src/index.js"

export class DummyNetworkAdapter extends NetworkAdapter {
  #startReady: boolean

  constructor({ startReady = true }: Options = {}) {
    super()
    this.#startReady = startReady
  }
  send() {}
  connect(_: string) {
    if (this.#startReady) {
      this.emit("ready", { network: this })
    }
  }
  disconnect() {}
}

type Options = {
  startReady?: boolean
}
