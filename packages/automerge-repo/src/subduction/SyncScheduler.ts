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
   * Returns the SedimentreeIds of all currently-attached documents.
   * Called on each periodic/batch tick to discover the working set.
   */
  getActiveSedimentreeIds: () => SedimentreeId[]

  /**
   * Called when a periodic or heal sync receives new data from peers.
   * The source should load the blobs into the document handle.
   */
  onSyncDataReceived: (
    sedimentreeId: SedimentreeId,
    subduction: Subduction
  ) => Promise<void>

  onHealExhausted?: OnHealExhausted

  /**
   * Interval in ms for per-document periodic sync. Each open document is
   * synced individually (skipping those already in heal-backoff).
   * Set to 0 to disable. Default: 30_000 (30s).
   */
  periodicSyncInterval: number

  /**
   * Interval in ms for a full batch sync across all sedimentrees.
   * On success, all heal state is reset.
   * Set to 0 to disable. Default: 300_000 (5 min).
   */
  batchSyncInterval: number
}

/**
 * Manages background periodic sync timers and self-healing retry logic.
 *
 * Two background timers run independently:
 *
 *   **periodicSync** — syncs each open document individually, skipping
 *       those already in heal-backoff.
 *
 *   **batchSync** — syncs every open document in one sweep. On full
 *       success, resets all heal state.
 *
 * When a sync fails for a sedimentree, exponential-backoff retries are
 * scheduled (2 s → 60 s cap, up to {@link HEAL_MAX_ATTEMPTS}). After
 * exhausting retries the application is notified via
 * {@link OnHealExhausted}.
 */
export class SyncScheduler {
  #subduction: Promise<Subduction>
  #log: debug.Debugger
  #getActiveSedimentreeIds: () => SedimentreeId[]
  #onSyncDataReceived: (
    sedimentreeId: SedimentreeId,
    subduction: Subduction
  ) => Promise<void>
  #onHealExhausted?: OnHealExhausted

  // ── Self-healing sync state ─────────────────────────────────────────
  #healTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #healBackoff = new Map<string, number>()
  #healAttempts = new Map<string, number>()

  // ── Periodic sync state ───────────────────────────────────────────
  #periodicSyncTimer: ReturnType<typeof setInterval> | null = null
  #batchSyncTimer: ReturnType<typeof setInterval> | null = null
  #periodicSyncInProgress = false
  #batchSyncInProgress = false

  constructor(options: SyncSchedulerOptions) {
    this.#subduction = options.subduction
    this.#log = options.log
    this.#getActiveSedimentreeIds = options.getActiveSedimentreeIds
    this.#onSyncDataReceived = options.onSyncDataReceived
    this.#onHealExhausted = options.onHealExhausted

    if (options.periodicSyncInterval > 0) {
      this.#periodicSyncTimer = setInterval(() => {
        void this.#runPeriodicSync()
      }, options.periodicSyncInterval)
    }
    if (options.batchSyncInterval > 0) {
      this.#batchSyncTimer = setInterval(() => {
        void this.#runBatchSync()
      }, options.batchSyncInterval)
    }
  }

  // ── Self-healing sync ────────────────────────────────────────────────
  //
  // When syncWithAllPeers fails for a sedimentree, we schedule a retry
  // with exponential backoff (2s → 60s cap). After HEAL_MAX_ATTEMPTS
  // consecutive failures we give up and notify the application via the
  // onHealExhausted callback.

  scheduleHealSync(sedimentreeId: SedimentreeId): void {
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

  // ── Periodic background sync ────────────────────────────────────────

  async #runPeriodicSync(): Promise<void> {
    if (this.#periodicSyncInProgress) return
    this.#periodicSyncInProgress = true

    try {
      const subduction = await this.#subduction
      const sedimentreeIds = this.#getActiveSedimentreeIds()

      const healingCount = sedimentreeIds.filter(id =>
        this.#healTimers.has(id.toString())
      ).length
      this.#log(
        `periodic sync: ${sedimentreeIds.length} entries, ` +
          `${healingCount} healing (skipped)`
      )

      const tasks: Array<Promise<void>> = []
      for (const sedimentreeId of sedimentreeIds) {
        const key = sedimentreeId.toString()
        // Skip sedimentrees already in heal-backoff
        if (this.#healTimers.has(key)) continue

        tasks.push(
          (async () => {
            try {
              const peerResultMap = await subduction.syncWithAllPeers(
                sedimentreeId,
                true
              )

              const results = peerResultMap.entries()
              if (results.length === 0) return

              // If data was received, update the handle immediately
              const dataReceived = results.some(r => {
                const s = r.stats
                return s && (s.commitsReceived > 0 || s.fragmentsReceived > 0)
              })
              if (dataReceived) {
                await this.#onSyncDataReceived(sedimentreeId, subduction)
              }

              const anyFailed = results.some(
                r => !r.success || (r.transportErrors?.length ?? 0) > 0
              )

              if (anyFailed) {
                this.scheduleHealSync(sedimentreeId)
              } else {
                this.resetHealState(key)
              }
            } catch (e) {
              console.warn(
                `[subduction] periodic sync failed for ${key.slice(0, 8)}:`,
                e
              )
            }
          })()
        )
      }

      await Promise.allSettled(tasks)
    } finally {
      this.#periodicSyncInProgress = false
    }
  }

  async #runBatchSync(): Promise<void> {
    if (this.#batchSyncInProgress) return
    this.#batchSyncInProgress = true
    this.#log("starting batch sync (all open handles)")

    try {
      const subduction = await this.#subduction
      const sedimentreeIds = this.#getActiveSedimentreeIds()
      let anyFailed = false

      const tasks: Array<Promise<void>> = []
      for (const sedimentreeId of sedimentreeIds) {
        const key = sedimentreeId.toString()
        tasks.push(
          (async () => {
            try {
              const peerResultMap = await subduction.syncWithAllPeers(
                sedimentreeId,
                true
              )

              const results = peerResultMap.entries()
              if (results.length === 0) return

              const entryFailed = results.some(
                r => !r.success || (r.transportErrors?.length ?? 0) > 0
              )
              if (entryFailed) anyFailed = true
            } catch (e) {
              anyFailed = true
              this.#log(`batch sync failed for ${key.slice(0, 8)}: %O`, e)
            }
          })()
        )
      }

      await Promise.allSettled(tasks)

      if (!anyFailed) {
        this.#log("batch sync succeeded — resetting all heal state")
        for (const timer of this.#healTimers.values()) {
          clearTimeout(timer)
        }
        this.#healTimers.clear()
        this.#healBackoff.clear()
        this.#healAttempts.clear()
      } else {
        this.#log("batch sync completed with errors")
      }
    } finally {
      this.#batchSyncInProgress = false
    }
  }

  // ── Shutdown ────────────────────────────────────────────────────────

  shutdown(): void {
    if (this.#periodicSyncTimer !== null) {
      clearInterval(this.#periodicSyncTimer)
      this.#periodicSyncTimer = null
    }
    if (this.#batchSyncTimer !== null) {
      clearInterval(this.#batchSyncTimer)
      this.#batchSyncTimer = null
    }
    for (const timer of this.#healTimers.values()) {
      clearTimeout(timer)
    }
    this.#healTimers.clear()
    this.#healBackoff.clear()
    this.#healAttempts.clear()
  }
}
