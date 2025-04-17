import { Message, NetworkAdapter, PeerId } from "@automerge/automerge-repo/slim"

export const pause = (t = 0) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), t))

type SendMessageFn = (message: Message) => void

export class DummyNetworkAdapter extends NetworkAdapter {
  #sendMessage: SendMessageFn
  #ready = false
  #readyResolver: ((value: void) => void) | undefined
  #readyPromise = new Promise<void>(resolve => {
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
  constructor(
    opts = { startReady: true, sendMessage: (_message: Message) => {} }
  ) {
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
  send(message: Message) {
    this.#sendMessage?.(message)
  }
  receive(message: Message) {
    this.emit("message", message)
  }
  static createConnectedPair({ latency = 10 } = {}) {
    const adapter1 = new DummyNetworkAdapter({
      startReady: true,
      sendMessage: (message: Message) =>
        pause(latency).then(() => adapter2.receive(message)),
    })
    const adapter2 = new DummyNetworkAdapter({
      startReady: true,
      sendMessage: message =>
        pause(latency).then(() => adapter1.receive(message)),
    })
    return [adapter1, adapter2]
  }
}
