import { pause } from "../../src/helpers/pause.js"
import { Message, NetworkAdapter, PeerId } from "../../src/index.js"

export class DummyNetworkAdapter extends NetworkAdapter {
  #sendMessage?: SendMessageFn

  #ready = false
  #isDroppingMessages = false
  #readyResolver?: () => void
  #readyPromise: Promise<void> = new Promise<void>(resolve => {
    this.#readyResolver = resolve
  })

  #droppedMessages: Message[] = []

  dropMessages(drop: boolean) {
    this.#isDroppingMessages = drop
  }

  getDroppedMessages() {
    return [...this.#droppedMessages]
  }

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
    if (this.#isDroppingMessages) {
      this.#droppedMessages.push(message)
    } else {
      this.#sendMessage?.(message)
    }
  }

  receive(message: Message) {
    if (this.#isDroppingMessages) {
      this.#droppedMessages.push(message)
    } else {
      this.emit("message", message)
    }
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
