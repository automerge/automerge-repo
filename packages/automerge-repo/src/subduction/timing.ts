/**
 * Opt-in timing collector for the Subduction cold-load + doc-build pipeline.
 *
 * Records structured events on the thread that owns a `SubductionSource` (the
 * "subduction thread") — including timings the doc-build pool Workers report
 * back through their RPC responses, and **failed / cancelled** requests — so a
 * session can be dumped and analysed afterwards.
 *
 * ON by default — every thread that runs a `SubductionSource` (main thread
 * and/or a SharedWorker) records automatically. This module installs a console
 * handle (`__subductionTimings`) on each such thread.
 *
 * **One merged view across threads:** every collector joins a same-origin
 * `BroadcastChannel`, so from *any* thread you can pull the tab's *and* the
 * SharedWorker's records together — no need to open each console:
 *
 * ```js
 * __subductionTimings.timelineTable()     // WHEN each phase ran (start/end ms from page load)
 * __subductionTimings.timeline().endMs    // ms from page load to last recorded activity
 * await __subductionTimings.tableAll()    // merged per-phase stats (all threads)
 * copy(await __subductionTimings.csvAll())          // merged CSV (has a `source` column)
 * copy(JSON.stringify(await __subductionTimings.collectAll()))   // merged raw dump
 * __subductionTimings.clearAll()          // reset every thread
 * ```
 *
 * Note `summary().totalMs` is the *sum* of a phase's durations (overlapping /
 * await-heavy phases over-count); for the page-load *timeline* — when each phase
 * actually started and ended — use `timeline()` / `timelineAll()`.
 *
 * Single-thread variants (this thread only): `.table()`, `.csv()`, `.records`,
 * `.failures`, `.clear()`. Control: `.disable()` / `.enable(true)`.
 */

/** Coarse pipeline stage a record belongs to. */
export type TimingPhase =
  | "find" // Repo.find(): call → handle ready (end-to-end, across all sources)
  | "sync-round" // network: subduction.syncWithAllPeers() (one round, all peers)
  | "get-blobs" // SubductionSource: subduction.getBlobs() (local read)
  | "transform" // SubductionSource: blob-interceptor (E2EE) transform pass
  | "worker-rtt" // client: dispatch → response wall (queue + build + save + transfer)
  | "apply-snapshot" // main thread: loadIncremental(doc, worker snapshot) + patch
  | "apply-inline" // main thread: loadIncremental(doc, merged) (no worker)
  | "flush-inbound" // main thread: loadIncremental of live peer-pushed blobs
  | "cold-load" // SubductionSource: end-to-end apply of a sedimentree's blobs
  | "save" // storage: subduction.storeBuiltBatch() (commits + fragments)

/** Whether the work the record describes completed, threw, or was abandoned. */
export type TimingOutcome = "ok" | "failed" | "cancelled"

export interface TimingRecord {
  /** `performance.now()` when recorded (per-thread monotonic clock). */
  ts: number
  /** `Date.now()` when recorded — wall clock, comparable across threads. */
  wallTs?: number
  /** Which thread recorded it (e.g. `"tab-9f3a"`, `"shared-worker-1b2c"`). */
  source?: string
  // `(string & {})` keeps literal autocomplete for the known phases while still
  // allowing any ad-hoc phase string (and avoids the union collapsing to `string`).
  phase: TimingPhase | (string & {})
  /** Defaults to `"ok"` when omitted. */
  outcome: TimingOutcome
  /** Short sedimentree id, for per-doc events. */
  sid?: string
  /** Pool worker index, for `worker-*` events. */
  worker?: number
  /** Primary duration in ms (for failed/cancelled: elapsed before the outcome). */
  ms: number
  /** Payload size in bytes (merged / snapshot), when relevant. */
  bytes?: number
  /** Error message for `failed` / `cancelled`. */
  error?: string
  /** Extra named sub-durations / counts (e.g. buildMs, saveMs, queueMs). */
  extra?: Record<string, number>
}

export interface PhaseStats {
  n: number
  ok: number
  failed: number
  cancelled: number
  meanMs: number
  p50: number
  p95: number
  maxMs: number
  totalMs: number
}

/** Wall-clock window of a phase, as offsets (ms) from the timeline anchor. */
export interface PhaseWindow {
  /** When the phase's earliest occurrence STARTED (offset from `t0`). */
  startMs: number
  /** When the phase's latest occurrence ENDED (offset from `t0`). */
  endMs: number
  /** `endMs - startMs` — the wall-clock span the phase covers (NOT summed work). */
  spanMs: number
  n: number
}

/** A wall-clock timeline of when each phase happened, anchored at `t0`. */
export interface Timeline {
  /** Anchor. For `timeline()` (single thread) this is 0 = the page's navigation
   *  start (offsets are `performance.now()`-based ms-since-load). For
   *  `timelineAll()` it's the epoch ms of the earliest event across threads. */
  t0: number
  /** Offset (ms from `t0`) of the very first event's start — 0 for a single
   *  thread anchored at page load, ≥0 for the merged view. */
  startMs: number
  /** Offset (ms from `t0`) of the very last event's end. For a single thread
   *  this is "ms from page load to the last recorded activity". */
  endMs: number
  /** `endMs - startMs` — total wall-clock span covered by the records. */
  spanMs: number
  /** Per-phase windows, ordered by `startMs`. */
  phases: Record<string, PhaseWindow>
}

const CHANNEL_NAME = "subduction-timings"

interface DumpRequest {
  t: "req"
  reqId: string
}
interface DumpResponse {
  t: "res"
  reqId: string
  records: TimingRecord[]
}
interface ClearAll {
  t: "clear"
}
type ChannelMsg = DumpRequest | DumpResponse | ClearAll

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

const round = (n: number): number => Math.round(n * 10) / 10

/** Best-effort label for the current thread. */
const detectSource = (): string => {
  const g = globalThis as Record<string, unknown>
  let kind = "thread"
  try {
    const SWGS = g.SharedWorkerGlobalScope as (new () => object) | undefined
    const DWGS = g.DedicatedWorkerGlobalScope as (new () => object) | undefined
    if (SWGS && g instanceof SWGS) kind = "shared-worker"
    else if (DWGS && g instanceof DWGS) kind = "worker"
    else if (typeof g.window !== "undefined" && g.window === g) kind = "tab"
  } catch {
    // best-effort only
  }
  return `${kind}-${Math.random().toString(36).slice(2, 6)}`
}

export class TimingCollector {
  /**
   * ON by default — every `SubductionSource` thread (tab + SharedWorker)
   * collects automatically, so data is there without any setup. Turn it off
   * with `__subductionTimings.disable()` (or `subductionTimings.disable()`).
   * Recording is a single push into a bounded ring (`#max`), so the cost is
   * negligible and memory is capped.
   */
  enabled = true
  /** When true, also `console.debug` each event as it lands. */
  verbose = false
  /** Label identifying this thread in merged (`*All`) views; override freely. */
  source = detectSource()
  #records: TimingRecord[] = []
  #max = 200_000
  #channel?: BroadcastChannel | null

  enable(verbose = false): this {
    this.enabled = true
    this.verbose = verbose
    return this
  }

  disable(): this {
    this.enabled = false
    return this
  }

  clear(): this {
    this.#records = []
    return this
  }

  /** All records on THIS thread, in arrival order. */
  get records(): readonly TimingRecord[] {
    return this.#records
  }

  /** Just the failed + cancelled records (what often matters most). */
  get failures(): TimingRecord[] {
    return this.#records.filter(r => r.outcome !== "ok")
  }

  record(rec: TimingRecord): void {
    if (!this.enabled) return
    rec.source ??= this.source
    rec.wallTs ??= Date.now()
    if (this.#records.length >= this.#max) this.#records.shift()
    this.#records.push(rec)
    // Make sure this thread can answer cross-thread dump requests.
    this.#ensureChannel()

    if (this.verbose) {
      const tag = rec.outcome === "ok" ? "" : ` ${rec.outcome.toUpperCase()}`
      // eslint-disable-next-line no-console
      console.debug(
        `[sdn-timing ${rec.source}] ${rec.phase}${tag}` +
          (rec.sid ? ` sid=${rec.sid}` : "") +
          (rec.worker !== undefined ? ` w${rec.worker}` : "") +
          ` ${round(rec.ms)}ms` +
          (rec.bytes !== undefined ? ` ${round(rec.bytes / 1024)}KB` : "") +
          (rec.error ? ` err=${rec.error}` : "")
      )
    }
  }

  // ── single-thread views ────────────────────────────────────────────

  /** Per-phase aggregate stats for THIS thread, incl. ok/failed/cancelled. */
  summary(): Record<string, PhaseStats> {
    return summarize(this.#records)
  }

  /** `console.table` of {@link summary} (this thread). */
  table(): void {
    // eslint-disable-next-line no-console
    console.table(this.summary())
  }

  /** Flat CSV of THIS thread's records. */
  csv(): string {
    return toCsv(this.#records)
  }

  // ── merged, cross-thread views ─────────────────────────────────────

  /**
   * Records from THIS thread plus every other same-origin thread that answers
   * within `timeoutMs`, sorted by wall clock. Use this to see the tab and the
   * SharedWorker together. Falls back to this thread's records where
   * `BroadcastChannel` is unavailable.
   */
  async collectAll(timeoutMs = 300): Promise<TimingRecord[]> {
    const merged = this.#records.slice()
    const ch = this.#ensureChannel()
    if (!ch) return sortByWall(merged)

    const reqId = Math.random().toString(36).slice(2)
    await new Promise<void>(resolve => {
      const onMsg = (e: MessageEvent) => {
        const m = e.data as ChannelMsg | undefined
        if (m && m.t === "res" && m.reqId === reqId) {
          for (const r of m.records) merged.push(r)
        }
      }
      ch.addEventListener("message", onMsg)
      ch.postMessage({ t: "req", reqId } satisfies DumpRequest)
      setTimeout(() => {
        ch.removeEventListener("message", onMsg)
        resolve()
      }, timeoutMs)
    })
    return sortByWall(merged)
  }

  /** Per-phase stats merged across all threads. */
  async summaryAll(timeoutMs = 300): Promise<Record<string, PhaseStats>> {
    return summarize(await this.collectAll(timeoutMs))
  }

  /** `console.table` of {@link summaryAll}. */
  async tableAll(timeoutMs = 300): Promise<void> {
    // eslint-disable-next-line no-console
    console.table(await this.summaryAll(timeoutMs))
  }

  /** Merged CSV across all threads (includes the `source` column). */
  async csvAll(timeoutMs = 300): Promise<string> {
    return toCsv(await this.collectAll(timeoutMs))
  }

  // ── wall-clock timeline (when, not how-much) ───────────────────────

  /**
   * Wall-clock timeline of THIS thread: per-phase start/end as offsets (ms) from
   * page navigation start, plus the overall `startMs`/`endMs`/`spanMs`. On the
   * tab, `endMs` is "ms from page load to the last recorded subduction activity"
   * — i.e. the end of the load as far as this instrumentation can see.
   */
  timeline(): Timeline {
    return buildTimeline(this.#records, "ts")
  }

  /** `console.table` of {@link timeline}'s per-phase windows (sorted by start). */
  timelineTable(): void {
    // eslint-disable-next-line no-console
    console.table(this.timeline().phases)
  }

  /**
   * Wall-clock timeline merged across all threads, anchored (offset 0) at the
   * earliest event. Uses `Date.now()` timestamps so the tab and SharedWorker
   * share one clock. `t0` is the epoch ms of that anchor.
   */
  async timelineAll(timeoutMs = 300): Promise<Timeline> {
    return buildTimeline(await this.collectAll(timeoutMs), "wall")
  }

  /** `console.table` of {@link timelineAll}'s per-phase windows. */
  async timelineTableAll(timeoutMs = 300): Promise<void> {
    // eslint-disable-next-line no-console
    console.table((await this.timelineAll(timeoutMs)).phases)
  }

  /** Clear this thread and broadcast a clear to every other thread. */
  clearAll(): void {
    this.clear()
    this.#ensureChannel()?.postMessage({ t: "clear" } satisfies ClearAll)
  }

  /** Close the cross-thread channel (it lazily reopens on the next record). */
  close(): void {
    if (this.#channel) {
      this.#channel.removeEventListener("message", this.#onChannelMessage)
      this.#channel.close()
    }
    this.#channel = undefined
  }

  // ── BroadcastChannel plumbing ──────────────────────────────────────

  #ensureChannel(): BroadcastChannel | null {
    if (this.#channel !== undefined) return this.#channel
    try {
      if (typeof BroadcastChannel === "undefined") {
        this.#channel = null
        return null
      }
      const ch = new BroadcastChannel(CHANNEL_NAME)
      ch.addEventListener("message", this.#onChannelMessage)
      // Node: don't let the channel keep the process alive (no-op in browsers).
      ;(ch as { unref?: () => void }).unref?.()
      this.#channel = ch
      return ch
    } catch {
      this.#channel = null
      return null
    }
  }

  #onChannelMessage = (e: MessageEvent) => {
    const m = e.data as ChannelMsg | undefined
    if (!m) return
    if (m.t === "req") {
      this.#channel?.postMessage({
        t: "res",
        reqId: m.reqId,
        records: this.#records,
      } satisfies DumpResponse)
    } else if (m.t === "clear") {
      this.#records = []
    }
  }
}

function sortByWall(recs: TimingRecord[]): TimingRecord[] {
  return recs.sort((a, b) => (a.wallTs ?? a.ts) - (b.wallTs ?? b.ts))
}

/**
 * Turn records into a wall-clock timeline (start/end per phase), as offsets from
 * an anchor. A record is stamped at the *end* of its operation, so its start is
 * `clockEnd - ms`.
 *
 * - `clock: "ts"` uses `performance.now()` — on the tab that's ms-since-page-load,
 *   so offsets are directly "relative to page load". Single-thread only (each
 *   thread has its own `performance` origin).
 * - `clock: "wall"` uses `wallTs` (`Date.now()`), comparable across threads;
 *   anchored at the earliest event so offsets start at 0.
 */
function buildTimeline(
  records: readonly TimingRecord[],
  clock: "ts" | "wall"
): Timeline {
  const endOf = (r: TimingRecord) =>
    clock === "wall" ? (r.wallTs ?? r.ts) : r.ts
  const startOf = (r: TimingRecord) => endOf(r) - r.ms

  if (records.length === 0) {
    return { t0: 0, startMs: 0, endMs: 0, spanMs: 0, phases: {} }
  }

  // For "ts" the anchor is the page navigation start (offset 0 = load). For
  // "wall" it's the earliest event start.
  const t0 = clock === "wall" ? Math.min(...records.map(startOf)) : 0

  const acc = new Map<string, { start: number; end: number; n: number }>()
  let firstStart = Infinity
  let lastEnd = 0
  for (const r of records) {
    const s = startOf(r) - t0
    const e = endOf(r) - t0
    firstStart = Math.min(firstStart, s)
    lastEnd = Math.max(lastEnd, e)
    const cur = acc.get(r.phase)
    if (cur) {
      cur.start = Math.min(cur.start, s)
      cur.end = Math.max(cur.end, e)
      cur.n++
    } else {
      acc.set(r.phase, { start: s, end: e, n: 1 })
    }
  }

  const phases = Object.fromEntries(
    [...acc.entries()]
      .sort((a, b) => a[1].start - b[1].start)
      .map(([phase, v]) => [
        phase,
        {
          startMs: round(v.start),
          endMs: round(v.end),
          spanMs: round(v.end - v.start),
          n: v.n,
        } satisfies PhaseWindow,
      ])
  )

  return {
    t0,
    startMs: round(firstStart),
    endMs: round(lastEnd),
    spanMs: round(lastEnd - firstStart),
    phases,
  }
}

function summarize(
  records: readonly TimingRecord[]
): Record<string, PhaseStats> {
  const byPhase = new Map<string, TimingRecord[]>()
  for (const r of records) {
    const arr = byPhase.get(r.phase)
    if (arr) arr.push(r)
    else byPhase.set(r.phase, [r])
  }

  const out: Record<string, PhaseStats> = {}
  for (const [phase, recs] of byPhase) {
    const ms = recs.map(r => r.ms).sort((a, b) => a - b)
    const total = ms.reduce((n, x) => n + x, 0)
    out[phase] = {
      n: recs.length,
      ok: recs.filter(r => r.outcome === "ok").length,
      failed: recs.filter(r => r.outcome === "failed").length,
      cancelled: recs.filter(r => r.outcome === "cancelled").length,
      meanMs: round(total / recs.length),
      p50: round(quantile(ms, 0.5)),
      p95: round(quantile(ms, 0.95)),
      maxMs: round(ms[ms.length - 1] ?? 0),
      totalMs: round(total),
    }
  }
  return out
}

function toCsv(records: readonly TimingRecord[]): string {
  const head = "wallTs,ts,source,phase,outcome,sid,worker,ms,bytes,error,extra"
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
  const rows = records.map(r =>
    [
      r.wallTs ?? "",
      round(r.ts),
      r.source ?? "",
      r.phase,
      r.outcome,
      r.sid ?? "",
      r.worker ?? "",
      round(r.ms),
      r.bytes ?? "",
      r.error ? esc(r.error) : "",
      r.extra ? esc(JSON.stringify(r.extra)) : "",
    ].join(",")
  )
  return [head, ...rows].join("\n")
}

/** Process-/thread-wide collector. Import this anywhere on the same thread. */
export const subductionTimings = new TimingCollector()

// Install a console-friendly handle on whatever global this thread has.
try {
  ;(globalThis as Record<string, unknown>).__subductionTimings =
    subductionTimings
} catch {
  // No writable global (unusual) — the exported singleton still works.
}
