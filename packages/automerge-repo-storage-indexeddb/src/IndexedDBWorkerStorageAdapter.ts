/**
 * A {@link StorageAdapterInterface} that runs IndexedDB in a Worker, falling
 * back to an in-thread {@link IndexedDBStorageAdapter} where Workers aren't
 * available.
 *
 * The worker may be a dedicated `Worker`, any `MessagePort` whose far side
 * runs the storage host (e.g. a port donated into a SharedWorker — Chrome
 * cannot spawn workers from a SharedWorker), or a provider function that
 * yields such a port on demand. Provider-obtained ports are re-fetched
 * after the port's `close` event fires (far side crashed or shut down), so
 * storage recovers across worker restarts.
 *
 * @packageDocumentation
 */
import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
  WorkerPortLike,
  WorkerPortSource,
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

/** Deadline for the worker to answer the `init` RPC (a dead donated port
 * would otherwise wedge every storage call forever). */
const DEFAULT_INIT_TIMEOUT_MS = 10_000

function randomClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * The listener surface beyond {@link WorkerPortLike} that a dedicated
 * `Worker` offers ("error" / "messageerror"); feature-sniffed, since a
 * `MessagePort` lacks "error".
 */
interface WorkerErrorEvents {
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
}

class WorkerBackedIndexedDB implements StorageAdapterInterface {
  #database: string
  #store: string
  #source: () => WorkerPortLike | Promise<WorkerPortLike>
  /**
   * Whether losing the port is recoverable. True only for provider
   * functions, which can yield a fresh port (e.g. re-donated by a tab
   * after the io worker restarts). A concrete supplied port or an
   * auto-spawned worker has no replacement: its loss is terminal.
   */
  #retryable: boolean
  /** Only an auto-spawned dedicated worker is terminated on close. */
  #terminateOwned: (() => void) | null = null
  #initTimeoutMs: number
  /** Set when the port is lost irrecoverably; every call rejects with it. */
  #dead: Error | null = null

  #port: WorkerPortLike | null = null
  /** Init handshake for the current port; cleared when the port dies. */
  #ready: Promise<void> | null = null
  #client = randomClientId()
  #nextId = 0
  #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >()
  #closed = false

  constructor(
    database: string,
    store: string,
    source: () => WorkerPortLike | Promise<WorkerPortLike>,
    {
      retryable = false,
      terminateOwned = null,
      initTimeoutMs = DEFAULT_INIT_TIMEOUT_MS,
    }: {
      retryable?: boolean
      terminateOwned?: (() => void) | null
      initTimeoutMs?: number
    } = {}
  ) {
    this.#database = database
    this.#store = store
    this.#source = source
    this.#retryable = retryable
    this.#terminateOwned = terminateOwned
    this.#initTimeoutMs = initTimeoutMs
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
    this.#dropPort(new WorkerStorageError(message))
  }

  #onPortClose = () => {
    this.#dropPort(
      new WorkerStorageError("IndexedDB storage worker port closed")
    )
  }

  /**
   * Fail all pending calls and forget the port. For a retryable source
   * the next storage call re-invokes it for a fresh port (and re-inits),
   * so a donated replacement port heals storage; otherwise the loss is
   * terminal and every subsequent call rejects immediately.
   */
  #dropPort(error: Error) {
    if (!this.#retryable) this.#dead ??= error
    const port = this.#port
    this.#port = null
    this.#ready = null
    if (port) this.#detach(port)
    for (const { reject } of this.#pending.values()) reject(error)
    this.#pending.clear()
  }

  #detach(port: WorkerPortLike) {
    port.removeEventListener("message", this.#onMessage)
    port.removeEventListener("close", this.#onPortClose)
    const errPort = port as unknown as WorkerErrorEvents
    errPort.removeEventListener?.("error", this.#onError)
    errPort.removeEventListener?.("messageerror", this.#onError)
  }

  /** Resolve (or reuse) the port and complete the init handshake. */
  async #ensureReady(): Promise<WorkerPortLike> {
    if (this.#closed)
      throw new WorkerStorageError("IndexedDB storage adapter closed")
    if (this.#dead) throw this.#dead
    if (this.#port && this.#ready) {
      await this.#ready
      return this.#port
    }

    const port = await this.#source()
    if (this.#closed)
      throw new WorkerStorageError("IndexedDB storage adapter closed")

    this.#port = port
    port.addEventListener("message", this.#onMessage)
    // MessagePort-only death signal; a dedicated Worker never fires it.
    port.addEventListener("close", this.#onPortClose)
    // Dedicated-Worker-only crash signals; a MessagePort lacks "error".
    const errPort = port as unknown as WorkerErrorEvents
    errPort.addEventListener?.("error", this.#onError)
    errPort.addEventListener?.("messageerror", this.#onError)
    port.start?.()

    const init = this.#call(port, "init", [this.#database, this.#store])
    this.#ready = this.#withInitTimeout(init, port).then(() => undefined)
    await this.#ready
    return port
  }

  /** Reject init after the deadline so a dead donated port surfaces fast. */
  #withInitTimeout(init: Promise<unknown>, port: WorkerPortLike) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new WorkerStorageError(
          `IndexedDB storage worker did not answer init within ` +
            `${this.#initTimeoutMs}ms. The worker may have failed to load ` +
            `or the supplied port's far side may be dead.`
        )
        if (this.#port === port) this.#dropPort(error)
        reject(error)
      }, this.#initTimeoutMs)
    })
    return Promise.race([init, timeout]).finally(() => clearTimeout(timer))
  }

  #call(
    port: WorkerPortLike,
    method: StorageRpcMethod,
    args: unknown[]
  ): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      port.postMessage({
        channel: STORAGE_RPC,
        client: this.#client,
        id,
        method,
        args,
      })
    })
  }

  async #rpc(method: StorageRpcMethod, args: unknown[]): Promise<unknown> {
    const port = await this.#ensureReady()
    return this.#call(port, method, args)
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.#rpc("load", [key]) as Promise<Uint8Array | undefined>
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    await this.#rpc("save", [key, data])
  }

  async remove(key: StorageKey): Promise<void> {
    await this.#rpc("remove", [key])
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    return this.#rpc("loadRange", [keyPrefix]) as Promise<Chunk[]>
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    await this.#rpc("removeRange", [keyPrefix])
  }

  async saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    await this.#rpc("saveBatch", [entries])
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#dropPort(new WorkerStorageError("IndexedDB storage adapter closed"))
    if (this.#terminateOwned) {
      this.#terminateOwned()
      this.#terminateOwned = null
    }
  }
}

export class IndexedDBWorkerStorageAdapter implements StorageAdapterInterface {
  #impl: StorageAdapterInterface
  #closed = false

  /**
   * @param worker - a dedicated `Worker`, a `MessagePort` whose far side
   *   runs the storage host, or a provider function returning (a promise
   *   of) such a port — re-invoked after the port closes, so a freshly
   *   donated port heals storage. Omit it to auto-spawn a dedicated
   *   worker (falls back to in-thread IndexedDB where Workers don't
   *   exist, e.g. inside a Chrome SharedWorker).
   */
  constructor(
    database: string = "automerge",
    store: string = "documents",
    worker?: WorkerPortSource
  ) {
    if (worker === undefined && typeof Worker === "undefined") {
      this.#impl = new IndexedDBStorageAdapter(database, store)
      return
    }
    try {
      this.#impl = makeWorkerBacked(database, store, worker)
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

function makeWorkerBacked(
  database: string,
  store: string,
  worker?: WorkerPortSource
): WorkerBackedIndexedDB {
  if (typeof worker === "function") {
    return new WorkerBackedIndexedDB(database, store, worker, {
      retryable: true,
    })
  }
  if (worker !== undefined) {
    return new WorkerBackedIndexedDB(database, store, () => worker)
  }
  // Auto-spawn: eager, so a construction failure is caught by the caller's
  // try/catch and falls back in-thread.
  const spawned = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  })
  return new WorkerBackedIndexedDB(
    database,
    store,
    () => spawned as unknown as WorkerPortLike,
    { terminateOwned: () => spawned.terminate() }
  )
}
