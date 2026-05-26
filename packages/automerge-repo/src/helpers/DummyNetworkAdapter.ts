import { pause } from "../../src/helpers/pause.js"
import { Message, NetworkAdapter, PeerId } from "../../src/index.js"

export class DummyNetworkAdapter extends NetworkAdapter {
  #sendMessage?: SendMessageFn

  #connected = false
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
    this.#connected = true
    this.peerId = peerId
  }

  disconnect() {
    this.#connected = false
  }

  peerCandidate(peerId: PeerId) {
    this.emit("peer-candidate", { peerId, peerMetadata: {} })
  }

  override send(message: Message) {
    if (!this.#connected) {
      return
    }
    this.#sendMessage?.(message)
  }

  receive(message: Message) {
    if (!this.#connected) {
      return
    }
    this.emit("message", message)
  }

  static createConnectedPair({ latency = 0 }: { latency?: number } = {}) {
    // Default to microtask delivery. `setTimeout`-based delivery (any
    // `latency > 0`) is subject to event-loop starvation under concurrent
    // test load, which produces flaky round-trip-heavy tests. Callers that
    // actually want to simulate latency can still pass a positive value.
    const deliver =
      latency === 0
        ? (adapter: DummyNetworkAdapter, message: Message) =>
            Promise.resolve().then(() => adapter.receive(message))
        : (adapter: DummyNetworkAdapter, message: Message) =>
            pause(latency).then(() => adapter.receive(message))

    const adapter1: DummyNetworkAdapter = new DummyNetworkAdapter({
      startReady: true,
      sendMessage: (message: Message) => deliver(adapter2, message),
    })
    const adapter2: DummyNetworkAdapter = new DummyNetworkAdapter({
      startReady: true,
      sendMessage: (message: Message) => deliver(adapter1, message),
    })

    return [adapter1, adapter2]
  }
}

type SendMessageFn = (message: Message) => void

type Options = {
  startReady?: boolean
  sendMessage?: SendMessageFn
}
