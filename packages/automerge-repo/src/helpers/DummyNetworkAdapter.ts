import { pause } from "../../src/helpers/pause.js"
import { Message, NetworkAdapter, PeerId } from "../../src/index.js"

export class DummyNetworkAdapter extends NetworkAdapter {
  #sendMessage?: SendMessageFn

  #ready = false
  #readyResolver?: () => void
  #readyPromise: Promise<void> = new Promise<void>(resolve => {
    this.#readyResolver = resolve
  })

  isReady() {
    return this.#ready
  }

  whenReady() {
    return this.#readyPromise
  }

  #forceReady() {
    if (!this.#ready) {
      this.#ready = true
      this.#readyResolver?.()
    }
  }

  // A public wrapper for use in tests!
  forceReady() {
    this.#forceReady()
  }

  constructor(opts: Options = { startReady: true }) {
    super()
    if (opts.startReady) {
      this.#forceReady()
    }
    this.#sendMessage = opts.sendMessage
  }

  connect(peerId: PeerId) {
    this.peerId = peerId
  }

  disconnect() {}

  peerCandidate(peerId: PeerId) {
    this.emit("peer-candidate", { peerId, peerMetadata: {} })
  }

  override send(message: Message) {
    this.#sendMessage?.(message)
  }

  receive(message: Message) {
    this.emit("message", message)
  }

  static createConnectedPair({ latency = 10 }: { latency?: number } = {}) {
    const adapter1: DummyNetworkAdapter = new DummyNetworkAdapter({
      startReady: true,
      sendMessage: (message: Message) =>
        pause(latency).then(() => adapter2.receive(message)),
    })
    const adapter2: DummyNetworkAdapter = new DummyNetworkAdapter({
      startReady: true,
      sendMessage: (message: Message) =>
        pause(latency).then(() => adapter1.receive(message)),
    })

    return [adapter1, adapter2]
  }
}

type SendMessageFn = (message: Message) => void

type Options = {
  startReady?: boolean
  sendMessage?: SendMessageFn
}
