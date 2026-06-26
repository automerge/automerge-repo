/**
 * Off-main-thread IndexedDB storage adapter.
 *
 * A drop-in {@link StorageAdapterInterface} whose IndexedDB work runs in a
 * Worker (structured clone + transaction callbacks off the main thread). Each
 * method is proxied to the worker over the {@link STORAGE_RPC} protocol.
 *
 * The worker is spawned internally via
 * `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`,
 * which Vite/webpack bundle for the consumer — so usage is just:
 *
 * ```ts
 * import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
 * const repo = new Repo({ storage: new IndexedDBWorkerStorageAdapter("my-app") })
 * ```
 *
 * @packageDocumentation
 */
import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo/slim"

import {
  STORAGE_RPC,
  type StorageRpcMethod,
  type StorageRpcResponse,
} from "./worker-rpc.js"

export class IndexedDBWorkerStorageAdapter implements StorageAdapterInterface {
  #worker: Worker
  #ownsWorker: boolean
  #nextId = 0
  #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >()
  #ready: Promise<unknown>

  /**
   * @param database - IndexedDB database name. Defaults to "automerge".
   * @param store - object store name. Defaults to "documents".
   * @param worker - optional existing Worker to reuse (e.g. one shared with the
   *   doc-build worker). If omitted, a dedicated worker is spawned.
   */
  constructor(
    database: string = "automerge",
    store: string = "documents",
    worker?: Worker
  ) {
    this.#worker =
      worker ??
      new Worker(new URL("./worker.js", import.meta.url), { type: "module" })
    this.#ownsWorker = worker === undefined
    this.#worker.addEventListener("message", this.#onMessage)
    this.#ready = this.#call("init", [database, store])
  }

  #onMessage = (e: MessageEvent) => {
    const msg = e.data as StorageRpcResponse
    if (!msg || msg.channel !== STORAGE_RPC) return
    const pending = this.#pending.get(msg.id)
    if (!pending) return
    this.#pending.delete(msg.id)
    if (msg.ok) pending.resolve(msg.result)
    else pending.reject(new Error(msg.error))
  }

  #call(method: StorageRpcMethod, args: unknown[]): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#worker.postMessage({ channel: STORAGE_RPC, id, method, args })
    })
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    await this.#ready
    return this.#call("load", [key]) as Promise<Uint8Array | undefined>
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    await this.#ready
    await this.#call("save", [key, data])
  }

  async remove(key: StorageKey): Promise<void> {
    await this.#ready
    await this.#call("remove", [key])
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    await this.#ready
    return this.#call("loadRange", [keyPrefix]) as Promise<Chunk[]>
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    await this.#ready
    await this.#call("removeRange", [keyPrefix])
  }

  async saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    await this.#ready
    await this.#call("saveBatch", [entries])
  }

  /** Terminate the internal worker (only if this adapter created it). */
  dispose(): void {
    this.#worker.removeEventListener("message", this.#onMessage)
    if (this.#ownsWorker) this.#worker.terminate()
  }
}
