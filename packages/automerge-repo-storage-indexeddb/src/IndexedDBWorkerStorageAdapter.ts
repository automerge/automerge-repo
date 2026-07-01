/**
 * A {@link StorageAdapterInterface} that runs IndexedDB in a Worker, falling
 * back to an in-thread {@link IndexedDBStorageAdapter} where Workers aren't
 * available.
 *
 * @packageDocumentation
 */
import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo/slim"

import { IndexedDBStorageAdapter } from "./index.js"
import {
  STORAGE_RPC,
  type StorageRpcMethod,
  type StorageRpcResponse,
} from "./worker-rpc.js"

/** Rejects pending calls when the worker is lost. */
export class WorkerStorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkerStorageError"
  }
}

function randomClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

class WorkerBackedIndexedDB implements StorageAdapterInterface {
  #worker: Worker
  #ownsWorker: boolean
  #client = randomClientId()
  #nextId = 0
  #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >()
  #dead: Error | null = null
  #ready: Promise<unknown>

  constructor(database: string, store: string, worker?: Worker) {
    this.#worker =
      worker ??
      new Worker(new URL("./worker.js", import.meta.url), { type: "module" })
    this.#ownsWorker = worker === undefined
    this.#worker.addEventListener("message", this.#onMessage)
    this.#worker.addEventListener("error", this.#onError)
    this.#worker.addEventListener("messageerror", this.#onError)
    this.#ready = this.#call("init", [database, store])
    // Suppress unhandled-rejection if no method is ever called; real failures
    // still surface through each method's `await this.#ready`.
    void this.#ready.catch(() => {})
  }

  #onMessage = (e: MessageEvent) => {
    const msg = e.data as StorageRpcResponse
    if (!msg || msg.channel !== STORAGE_RPC || msg.client !== this.#client)
      return
    const pending = this.#pending.get(msg.id)
    if (!pending) return
    this.#pending.delete(msg.id)
    if (msg.ok) pending.resolve(msg.result)
    else pending.reject(new WorkerStorageError(msg.error))
  }

  #onError = (e: Event) => {
    const message =
      e instanceof ErrorEvent && e.message
        ? e.message
        : "IndexedDB storage worker terminated unexpectedly"
    this.#fail(new WorkerStorageError(message))
  }

  #fail(error: Error) {
    if (this.#dead) return
    this.#dead = error
    for (const { reject } of this.#pending.values()) reject(error)
    this.#pending.clear()
  }

  #call(method: StorageRpcMethod, args: unknown[]): Promise<unknown> {
    if (this.#dead) return Promise.reject(this.#dead)
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#worker.postMessage({
        channel: STORAGE_RPC,
        client: this.#client,
        id,
        method,
        args,
      })
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

  close(): void {
    this.#worker.removeEventListener("message", this.#onMessage)
    this.#worker.removeEventListener("error", this.#onError)
    this.#worker.removeEventListener("messageerror", this.#onError)
    this.#fail(new WorkerStorageError("IndexedDB storage adapter closed"))
    if (this.#ownsWorker) this.#worker.terminate()
  }
}

export class IndexedDBWorkerStorageAdapter implements StorageAdapterInterface {
  #impl: StorageAdapterInterface
  #closed = false

  /**
   * @param worker - an existing Worker to reuse; otherwise one is spawned.
   */
  constructor(
    database: string = "automerge",
    store: string = "documents",
    worker?: Worker
  ) {
    if (worker === undefined && typeof Worker === "undefined") {
      this.#impl = new IndexedDBStorageAdapter(database, store)
      return
    }
    try {
      this.#impl = new WorkerBackedIndexedDB(database, store, worker)
    } catch (error) {
      // e.g. WebKit contexts that reject nested module workers.
      console.warn(
        "[IndexedDBWorkerStorageAdapter] worker unavailable; falling back to in-thread IndexedDB:",
        error
      )
      this.#impl = new IndexedDBStorageAdapter(database, store)
    }
  }

  load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.#impl.load(key)
  }

  save(key: StorageKey, data: Uint8Array): Promise<void> {
    return this.#impl.save(key, data)
  }

  remove(key: StorageKey): Promise<void> {
    return this.#impl.remove(key)
  }

  loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    return this.#impl.loadRange(keyPrefix)
  }

  removeRange(keyPrefix: StorageKey): Promise<void> {
    return this.#impl.removeRange(keyPrefix)
  }

  saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    return this.#impl.saveBatch(entries)
  }

  /** Terminate the internal worker (only if this adapter created it). */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#impl.close?.()
  }
}
