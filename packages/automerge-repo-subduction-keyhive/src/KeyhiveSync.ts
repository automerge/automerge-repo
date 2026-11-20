import type { SubductionBackend } from "@automerge/automerge-repo-subduction"
import type { PeerId } from "@automerge/subduction/slim"
import { log } from "./logging.js"
import type { LocalKeyhive } from "./LocalKeyhive.js"
import { Rerun } from "./utilities.js"

export interface KeyhiveSyncOptions {
  /** A backend constructed with `local.access()` as its `keyhive` option. */
  inner: SubductionBackend
  local: LocalKeyhive
  /** Called after keyhive state from a peer has been ingested. */
  onIngest: () => void
  /** Called after a peer has shown it ingested keyhive events this replica
   * sent it. */
  onDelivered: () => void
  /** Called after every keyhive frame from a peer, after the two above. */
  onFrame: () => void
  /** Milliseconds between sync rounds (2000 by default). With `null`, rounds
   * run only on the backup timer and {@link KeyhiveSync.sync}. Must be
   * positive. */
  syncIntervalMs?: number | null
  /** Milliseconds between backup syncs (2 minutes by default). `null` turns
   * them off. Must be positive. */
  backupSyncIntervalMs?: number | null
  /** Called on each backup sync, after its keyhive sync round has started. */
  onBackup: () => void
}

const DEFAULT_SYNC_INTERVAL_MS = 2000
const DEFAULT_BACKUP_SYNC_INTERVAL_MS = 2 * 60 * 1000
/**
 * Starts rounds of Subduction's keyhive sync protocol with every connected
 * peer and reports what the peers' keyhive frames changed. A peer's
 * Subduction key must also be its keyhive identity.
 */
export class KeyhiveSync {
  readonly #inner: SubductionBackend
  readonly #local: LocalKeyhive
  readonly #timers: ReturnType<typeof setInterval>[] = []
  /** `local.changeCounter` at the last cache refresh. */
  #counterAtRefresh?: number
  /** Whether the next tick starts full rounds. */
  #fullRequested = false
  /** Peers whose next round is a full one. */
  readonly #fullFor = new Set<PeerId>()
  /**
   * Runs one tick at a time. A tick lists the connected peers, refreshes the
   * event cache if keyhive changed, and starts a round with each peer.
   */
  readonly #ticks = new Rerun(async () => {
    const full = this.#fullRequested
    this.#fullRequested = false
    await this.#startRounds(full).catch(error =>
      log.warn("[KeyhiveSync] sync failed:", error)
    )
  })
  /**
   * Runs one round at a time for each peer.
   */
  readonly #peerRounds = new Rerun<PeerId>(async peer => {
    const full = this.#fullFor.delete(peer)
    const subduction = this.#inner.subduction
    await (
      full
        ? subduction.fullSyncKeyhiveWithPeer(peer)
        : subduction.syncKeyhiveWithPeer(peer)
    ).catch(error => log.warn("[KeyhiveSync] sync with a peer failed:", error))
  })

  constructor(options: KeyhiveSyncOptions) {
    this.#inner = options.inner
    this.#local = options.local
    options.inner.onKeyhiveOutcome((_peer, ingested, confirmed) => {
      if (ingested) options.onIngest()
      if (confirmed) options.onDelivered()
      options.onFrame()
    })
    this.#every(options.syncIntervalMs, DEFAULT_SYNC_INTERVAL_MS, () =>
      this.#round(false)
    )
    // A frame that fails is not reported even if it ingested events. This
    // runs a full keyhive sync and lets the caller repeat what `onIngest` and
    // `onDelivered` start.
    this.#every(
      options.backupSyncIntervalMs,
      DEFAULT_BACKUP_SYNC_INTERVAL_MS,
      () => {
        this.sync()
        options.onBackup()
      }
    )
  }

  /** Start a full keyhive sync round with each connected peer. */
  sync(): void {
    this.#round(true)
  }

  /**
   * Start a tick now or once more after the tick in progress.
   */
  #round(full: boolean): void {
    if (full) this.#fullRequested = true
    this.#ticks.run()
  }

  /**
   * Refresh the event cache if keyhive changed, then start a round with each
   * connected peer. Unless `full` is set, a peer with a syncpoint from an
   * earlier round gets a digest check instead of a full comparison.
   */
  async #startRounds(full: boolean): Promise<void> {
    const subduction = this.#inner.subduction
    const peers = await subduction.getConnectedPeerIds()
    if (peers.length === 0) return
    const counter = this.#local.changeCounter
    if (full || counter !== this.#counterAtRefresh) {
      await subduction.refreshKeyhiveCache()
      this.#counterAtRefresh = counter
    }
    for (const peer of peers) {
      if (full) this.#fullFor.add(peer)
      this.#peerRounds.run(peer)
    }
  }

  close(): void {
    this.#timers.forEach(clearInterval)
    this.#inner.onKeyhiveOutcome(undefined)
  }

  #every(
    configured: number | null | undefined,
    defaultMs: number,
    run: () => void
  ): void {
    const interval = configured === undefined ? defaultMs : configured
    if (interval === null) return
    const timer = setInterval(run, interval)
    ;(timer as { unref?: () => void }).unref?.()
    this.#timers.push(timer)
  }
}
