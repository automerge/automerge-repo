import type * as N from "@automerge/subduction"

interface Pending<T> {
  resolve(value: T): void
  reject(error: Error): void
}

/** Ordered, copying framed-byte wire; pause blocks outgoing sends. */
export class RepoTransport implements N.Transport {
  private other!: RepoTransport
  private frames: Uint8Array[] = []
  private receivers: Pending<Uint8Array>[] = []
  private sends: (Pending<void> & { bytes: Uint8Array })[] = []
  private callbacks = new Set<() => void>()
  private failure?: Error
  private paused = false

  static pair(): [RepoTransport, RepoTransport] {
    const a = new RepoTransport(),
      b = new RepoTransport()
    a.other = b
    b.other = a
    return [a, b]
  }

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
    const endpoints = [this, this.other]
    // Seal both ends before callbacks can reenter either endpoint.
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
