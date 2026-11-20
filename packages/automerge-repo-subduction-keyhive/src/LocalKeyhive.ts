import type { SubductionStorageAdapterInterface } from "@automerge/automerge-repo-subduction"
import type { KeyhiveAccess } from "@automerge/subduction/slim"
import {
  CiphertextStore,
  Keyhive,
  type Event as KeyhiveEvent,
  type Signer,
} from "@keyhive/keyhive/slim"
import { keyhiveAccess } from "./keyhiveAccess.js"
import { log } from "./logging.js"
import { PromiseQueue } from "./PromiseQueue.js"
import { KeyhiveStorage } from "./KeyhiveStorage.js"
import { freeAfter } from "./utilities.js"

/** A keyhive instance, its storage, and the queue that serializes its calls. */
export class LocalKeyhive {
  readonly queue = new PromiseQueue()
  #events: Uint8Array[] = []
  #prekeysChanged = false
  #persistQueued = false
  #changeCounter = 0
  #access?: KeyhiveAccess

  private constructor(
    readonly keyhive: Keyhive,
    readonly storage: KeyhiveStorage
  ) {}

  /**
   * Load the state saved in `adapter` or create a new keyhive. `adapter`
   * stores this replica's prekey secrets unencrypted and must be treated
   * as secret.
   */
  static async open(
    signer: Signer,
    adapter: SubductionStorageAdapterInterface
  ): Promise<LocalKeyhive> {
    const storage = new KeyhiveStorage(adapter)
    let self: LocalKeyhive | undefined
    const early: KeyhiveEvent[] = []
    const onEvent = (event: KeyhiveEvent) => {
      if (self) {
        self.#onEvent(event)
      } else {
        early.push(event)
      }
    }
    const store = CiphertextStore.newInMemory()
    const archive = await storage.loadArchive()
    const keyhive = archive
      ? await freeAfter(archive, a => a.tryToKeyhive(store, signer, onEvent))
      : await Keyhive.init(signer, store, onEvent)
    await storage.loadPrekeySecrets(keyhive)
    const saved = await storage.ingestEvents(keyhive)
    self = new LocalKeyhive(keyhive, storage)
    for (const event of early) self.#onEvent(event)
    if (!saved) await storage.saveArchive(keyhive)
    await storage.savePrekeySecrets(keyhive)
    return self
  }

  /**
   * Write buffered events and, if they changed, the prekey secrets. Call from
   * inside a {@link queue} task so that key material reaches storage before
   * the ciphertext that depends on it. If a write fails, it's retained
   * for the next call.
   */
  async persist(): Promise<void> {
    const events = this.#events
    const prekeysChanged = this.#prekeysChanged
    this.#events = []
    this.#prekeysChanged = false
    try {
      if (events.length) await this.storage.saveEvents(events)
      if (prekeysChanged) await this.storage.savePrekeySecrets(this.keyhive)
    } catch (error) {
      this.#events = [...events, ...this.#events]
      this.#prekeysChanged ||= prekeysChanged
      throw error
    }
  }

  /**
   * The keyhive as the `KeyhiveAccess` that Subduction's `keyhive` option
   * expects. Each method except `id` runs in {@link queue} so Subduction's
   * keyhive calls do not overlap this package's. A queue task must never
   * wait for a Subduction call that reaches keyhive or each will wait for
   * the other. Every call returns the same object.
   */
  access(): KeyhiveAccess {
    if (this.#access) return this.#access
    const access = keyhiveAccess(this.keyhive)
    const queued = Object.entries(access).map(([name, method]) => {
      if (name === "id") return [name, method]
      const call = method as (...args: unknown[]) => Promise<unknown>
      return [name, (...args: unknown[]) => this.queue.run(() => call(...args))]
    })
    this.#access = Object.fromEntries(queued) as KeyhiveAccess
    return this.#access
  }

  /**
   * Increases each time keyhive reports an event to this replica. Compare it
   * with an earlier value to detect a change. It is not a count of keyhive's
   * events.
   */
  get changeCounter(): number {
    return this.#changeCounter
  }

  /**
   * Called from inside keyhive so it only buffers and schedules. Frees
   * `event`.
   */
  #onEvent(event: KeyhiveEvent): void {
    this.#changeCounter++
    this.#events.push(event.toBytes())
    const variant = event.variant
    event.free()
    // A CGKA operation of our own can rotate our leaf key and its secret is
    // stored with the prekey secrets.
    if (
      variant === "PREKEY_ROTATED" ||
      variant === "PREKEYS_EXPANDED" ||
      variant === "CGKA_OPERATION"
    ) {
      this.#prekeysChanged = true
    }
    if (this.#persistQueued) return
    this.#persistQueued = true
    void this.queue
      .run(async () => {
        this.#persistQueued = false
        await this.persist()
      })
      .catch(error => log.error("[LocalKeyhive] persist failed:", error))
  }
}
