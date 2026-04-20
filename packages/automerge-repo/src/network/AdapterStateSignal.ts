import { AdapterState } from "./NetworkAdapterInterface.js"

export class AdapterStateSignal implements AdapterState {
  #nextPromise: Promise<"ready" | "connecting">
  #resolveNext: (value: "ready" | "connecting") => void = () => {}
  #rejectNext: (reason?: unknown) => void = () => {}
  #done = false

  constructor(private currentValue: "ready" | "connecting") {
    this.#nextPromise = new Promise<"ready" | "connecting">(
      (resolve, reject) => {
        this.#resolveNext = resolve
        this.#rejectNext = reject
      }
    )
  }

  async *watch(): AsyncIterable<"ready" | "connecting"> {
    while (!this.#done) {
      try {
        yield await this.#nextPromise
      } catch (e) {
        // stopped - exit cleanly
      }
    }
  }

  get value() {
    return this.currentValue
  }

  set(value: "ready" | "connecting") {
    if (this.#done) return
    this.currentValue = value
    const lastResolve = this.#resolveNext
    this.#nextPromise = new Promise<"ready" | "connecting">(
      (resolve, reject) => {
        this.#resolveNext = resolve
        this.#rejectNext = reject
      }
    )
    // Prevent re-entrancy
    queueMicrotask(() => lastResolve(value))
  }

  stop() {
    this.#done = true
    this.#rejectNext(new Error("stopped"))
  }
}
