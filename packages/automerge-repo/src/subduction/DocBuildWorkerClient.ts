/**
 * Main-thread client for the doc-build Worker. Ships merged blob bytes to the
 * worker and resolves with the compact snapshot the worker produced (a
 * `save()` of `loadIncremental(init(), merged)`), which the caller applies via
 * `Automerge.loadIncremental(doc, snapshot)`.
 *
 * The worker is spawned internally via
 * `new Worker(new URL("./docBuild.worker.js", import.meta.url), { type: "module" })`
 * — Vite/webpack bundle it for the consumer.
 */
import { DOC_BUILD_RPC, type DocBuildResponse } from "./docBuildRpc.js"

export class DocBuildWorkerClient {
  #worker: Worker
  #ownsWorker: boolean
  #nextId = 0
  #pending = new Map<
    number,
    { resolve: (snapshot: Uint8Array) => void; reject: (e: unknown) => void }
  >()

  constructor(worker?: Worker) {
    this.#worker =
      worker ??
      new Worker(new URL("./docBuild.worker.js", import.meta.url), {
        type: "module",
      })
    this.#ownsWorker = worker === undefined
    this.#worker.addEventListener("message", this.#onMessage)
  }

  #onMessage = (e: MessageEvent) => {
    const msg = e.data as DocBuildResponse
    if (!msg || msg.channel !== DOC_BUILD_RPC) return
    const pending = this.#pending.get(msg.id)
    if (!pending) return
    this.#pending.delete(msg.id)
    if (msg.ok) pending.resolve(msg.snapshot)
    else pending.reject(new Error(msg.error))
  }

  /** Build the doc from `merged` in the worker; resolves with a compact snapshot. */
  build(merged: Uint8Array): Promise<Uint8Array> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      // Transfer a copy so the caller's `merged` is never detached.
      const copy = merged.slice()
      this.#worker.postMessage({ channel: DOC_BUILD_RPC, id, merged: copy }, [
        copy.buffer,
      ])
    })
  }

  dispose(): void {
    this.#worker.removeEventListener("message", this.#onMessage)
    if (this.#ownsWorker) this.#worker.terminate()
    this.#pending.clear()
  }
}
