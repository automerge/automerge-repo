import { SedimentreeId, Subduction } from "@automerge/automerge-subduction/slim"
import { DocumentId } from "../types.js"
import { toDocumentId } from "./helpers.js"
import debug from "debug"

// ── Self-healing sync constants ─────────────────────────────────────────
const HEAL_INITIAL_DELAY_MS = 2_000
const HEAL_MAX_DELAY_MS = 60_000
const HEAL_MAX_ATTEMPTS = 10

/** Callback when heal sync gives up after all retry attempts. */
export type OnHealExhausted = (documentId: DocumentId) => void

export interface SyncSchedulerOptions {
  subduction: Promise<Subduction>
  log: debug.Debugger

  /**
   * Called when a heal sync receives new data from peers. The source
   * should load the blobs into the document handle.
   */
  onSyncDataReceived: (
    sedimentreeId: SedimentreeId,
    subduction: Subduction
  ) => Promise<void>

  onHealExhausted?: OnHealExhausted
}

/**
 * Manages self-healing retry logic for failed syncs.
 *
 * When a caller observes a failed `syncWithAllPeers` for a sedimentree,
 * it invokes {@link scheduleHealSync} to schedule an exponential-backoff
 * retry (2 s → 60 s cap, up to {@link HEAL_MAX_ATTEMPTS}). Each retry
 * calls `syncWithAllPeers`; if it recovers new commits/fragments, the
 * caller's {@link SyncSchedulerOptions.onSyncDataReceived} hook is
 * invoked so the handle can be updated. Successful retries clear the
 * heal state via {@link resetHealState}. After exhausting retries the
 * application is notified via {@link OnHealExhausted}.
 *
 * This is entirely event-driven: no background polling runs. All sync
 * attempts are triggered by real events (initial attach, reconnect,
 * local change, share-config change) in {@link SubductionSource} or by
 * heal retries scheduled here after a real failure.
 */
export class SyncScheduler {
  #subduction: Promise<Subduction>
  #log: debug.Debugger
  #onSyncDataReceived: (
    sedimentreeId: SedimentreeId,
    subduction: Subduction
  ) => Promise<void>
  #onHealExhausted?: OnHealExhausted

  // ── Self-healing sync state ─────────────────────────────────────────
  #healTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #healBackoff = new Map<string, number>()
  #healAttempts = new Map<string, number>()
  #isShutdown = false

  constructor(options: SyncSchedulerOptions) {
    this.#subduction = options.subduction
    this.#log = options.log
    this.#onSyncDataReceived = options.onSyncDataReceived
    this.#onHealExhausted = options.onHealExhausted
  }

  // ── Self-healing sync ────────────────────────────────────────────────
  //
  // When syncWithAllPeers fails for a sedimentree, we schedule a retry
  // with exponential backoff (2s → 60s cap). After HEAL_MAX_ATTEMPTS
  // consecutive failures we give up and notify the application via the
  // onHealExhausted callback.

  scheduleHealSync(sedimentreeId: SedimentreeId): void {
    if (this.#isShutdown) return
    const key = sedimentreeId.toString()
    const attempts = this.#healAttempts.get(key) ?? 0

    if (attempts >= HEAL_MAX_ATTEMPTS) {
      console.warn(
        `[subduction] heal EXHAUSTED for ${key.slice(
          0,
          8
        )} after ${attempts} attempts`
      )
      this.#onHealExhausted?.(toDocumentId(sedimentreeId))
      return
    }

    // Debounce: restart the window if a timer is already pending.
    const existing = this.#healTimers.get(key)
    if (existing !== undefined) clearTimeout(existing)

    const delay = this.#healBackoff.get(key) ?? HEAL_INITIAL_DELAY_MS

    this.#log(
      `scheduling heal for ${key.slice(0, 8)} in ${delay}ms ` +
        `(attempt ${attempts + 1}/${HEAL_MAX_ATTEMPTS})`
    )

    const timer = setTimeout(() => {
      void this.#executeHealSync(sedimentreeId)
    }, delay)
    this.#healTimers.set(key, timer)
  }

  async #executeHealSync(sedimentreeId: SedimentreeId): Promise<void> {
    const key = sedimentreeId.toString()
    this.#healTimers.delete(key)
    this.#healAttempts.set(key, (this.#healAttempts.get(key) ?? 0) + 1)

    this.#log(`executing heal sync for ${key.slice(0, 8)}...`)

    try {
      const subduction = await this.#subduction
      const peerResultMap = await subduction.syncWithAllPeers(
        sedimentreeId,
        true
      )

      const results = peerResultMap.entries()
      const anyFailed = results.some(
        r => !r.success || (r.transportErrors?.length ?? 0) > 0
      )

      // If new data was received during the heal, load it into the handle
      // immediately — otherwise the recovered commits/fragments would sit
      // in subduction storage until some other event surfaced them.
      const dataReceived = results.some(r => {
        const s = r.stats
        return s && (s.commitsReceived > 0 || s.fragmentsReceived > 0)
      })
      if (dataReceived) {
        try {
          await this.#onSyncDataReceived(sedimentreeId, subduction)
        } catch (e) {
          this.#log(
            `onSyncDataReceived threw during heal for ${key.slice(0, 8)}: %O`,
            e
          )
        }
      }

      if (anyFailed || results.length === 0) {
        const currentDelay = this.#healBackoff.get(key) ?? HEAL_INITIAL_DELAY_MS
        const nextDelay = Math.min(currentDelay * 2, HEAL_MAX_DELAY_MS)
        this.#healBackoff.set(key, nextDelay)
        this.scheduleHealSync(sedimentreeId)
      } else {
        this.#log(`heal sync succeeded for ${key.slice(0, 8)}`)
        this.resetHealState(key)
      }
    } catch (e) {
      this.#log(`heal sync threw for ${key.slice(0, 8)}: %O`, e)
      const currentDelay = this.#healBackoff.get(key) ?? HEAL_INITIAL_DELAY_MS
      const nextDelay = Math.min(currentDelay * 2, HEAL_MAX_DELAY_MS)
      this.#healBackoff.set(key, nextDelay)
      this.scheduleHealSync(sedimentreeId)
    }
  }

  resetHealState(key: string): void {
    const timer = this.#healTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.#healTimers.delete(key)
    this.#healBackoff.delete(key)
    this.#healAttempts.delete(key)
  }

  /** Check whether a sedimentree is currently in heal-backoff. */
  isHealing(sedimentreeId: SedimentreeId): boolean {
    return this.#healTimers.has(sedimentreeId.toString())
  }

  // ── Shutdown ────────────────────────────────────────────────────────

  shutdown(): void {
    this.#isShutdown = true
    for (const timer of this.#healTimers.values()) {
      clearTimeout(timer)
    }
    this.#healTimers.clear()
    this.#healBackoff.clear()
    this.#healAttempts.clear()
  }
}
