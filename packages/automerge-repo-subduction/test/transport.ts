import type * as N from "@automerge/subduction"

interface Pending<T> {
  resolve(value: T): void
  reject(error: Error): void
}

/** A framed (one send = one receive), ordered, copying in-process byte wire. */
export class PairedTransport implements N.Transport {
  private other!: PairedTransport
  private frames: Uint8Array[] = []
  private receivers: Pending<Uint8Array>[] = []
  private sends: (Pending<void> & { bytes: Uint8Array })[] = []
  private callbacks = new Set<() => void>()
  private failure?: Error
  private paused = false
  /** Acknowledge but discard outgoing frames, to simulate a blackholed link. */
  drop = false

  static pair(): [PairedTransport, PairedTransport] {
    const a = new PairedTransport(),
      b = new PairedTransport()
    a.other = b
    b.other = a
    return [a, b]
  }

  get disconnected(): boolean {
    return this.failure !== undefined
  }

  /** Pause outgoing sends (including their promises) until resume/disconnect. */
  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    for (const send of this.sends.splice(0)) {
      if (this.failure) send.reject(this.failure)
      else {
        this.deliver(send.bytes)
        send.resolve()
      }
    }
  }

  async sendBytes(bytes: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure
    const copy = new Uint8Array(bytes)
    if (this.paused)
      return new Promise<void>((resolve, reject) => {
        this.sends.push({ bytes: copy, resolve, reject })
      })
    this.deliver(copy)
  }

  private deliver(bytes: Uint8Array): void {
    if (this.drop) return
    const receiver = this.other.receivers.shift()
    if (receiver) receiver.resolve(bytes)
    else this.other.frames.push(bytes)
  }

  async recvBytes(): Promise<Uint8Array> {
    if (this.failure) throw this.failure
    const frame = this.frames.shift()
    if (frame) return frame
    return new Promise((resolve, reject) => {
      this.receivers.push({ resolve, reject })
    })
  }

  onDisconnect(callback: () => void): void {
    if (this.failure) callback()
    else this.callbacks.add(callback)
  }

  async disconnect(): Promise<void> {
    if (this.failure) return
    const error = new Error("Test transport disconnected")
    // Seal BOTH ends before any callback can reenter either endpoint.
    const endpoints = [this, this.other]
    for (const endpoint of endpoints) {
      endpoint.failure = error
      endpoint.frames.length = 0
      for (const pending of endpoint.receivers.splice(0)) pending.reject(error)
      for (const pending of endpoint.sends.splice(0)) pending.reject(error)
    }
    const errors: unknown[] = []
    for (const endpoint of endpoints) {
      const callbacks = [...endpoint.callbacks]
      endpoint.callbacks.clear()
      for (const callback of callbacks) {
        try {
          callback()
        } catch (error) {
          errors.push(error)
        }
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Disconnect callbacks failed")
  }
}
