/**
 * Opt-in timing collector for the Subduction cold-load + doc-build pipeline.
 *
 * Records structured events on the thread that owns a `SubductionSource` (the
 * "subduction thread") — including timings the doc-build pool Workers report
 * back through their RPC responses, and **failed / cancelled** requests — so a
 * session can be dumped and analysed afterwards.
 *
 * Disabled by default (no allocation while off). Enable from the app or the
 * browser console via the global handle that this module installs on whichever
 * thread imports it (main thread and/or a Worker running a `SubductionSource`):
 *
 * ```js
 * __subductionTimings.enable()         // start recording (.enable(true) also console.debugs)
 * // … exercise the app: open docs, navigate …
 * __subductionTimings.table()          // per-phase stats incl. ok/failed/cancelled counts
 * __subductionTimings.failures         // just the failed + cancelled records
 * copy(__subductionTimings.csv())      // flat CSV → spreadsheet
 * copy(JSON.stringify(__subductionTimings.records))   // full dump
 * __subductionTimings.clear()
 * ```
 *
 * A doc-build Worker is a separate thread, so it reports its own build/save
 * timings back in the RPC response; the client records them here. A second
 * `SubductionSource` (e.g. one in a SharedWorker) keeps its own collector on
 * that thread — dump each thread's `__subductionTimings` separately.
 */

/** Coarse pipeline stage a record belongs to. */
export type TimingPhase =
  | "get-blobs" // SubductionSource: subduction.getBlobs()
  | "transform" // SubductionSource: blob-interceptor (E2EE) transform pass
  | "worker-rtt" // client: dispatch → response wall (queue + build + save + transfer)
  | "apply-snapshot" // main thread: loadIncremental(doc, worker snapshot) + patch
  | "apply-inline" // main thread: loadIncremental(doc, merged) (no worker)
  | "cold-load" // SubductionSource: end-to-end apply of a sedimentree's blobs

/** Whether the work the record describes completed, threw, or was abandoned. */
export type TimingOutcome = "ok" | "failed" | "cancelled"

export interface TimingRecord {
  /** `performance.now()` when recorded (subduction-thread clock). */
  ts: number
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

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

const round = (n: number): number => Math.round(n * 10) / 10

export class TimingCollector {
  enabled = false
  /** When true, also `console.debug` each event as it lands. */
  verbose = false
  #records: TimingRecord[] = []
  #max = 200_000

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

  /** All records, in arrival order. */
  get records(): readonly TimingRecord[] {
    return this.#records
  }

  /** Just the failed + cancelled records (what often matters most). */
  get failures(): TimingRecord[] {
    return this.#records.filter(r => r.outcome !== "ok")
  }

  record(rec: TimingRecord): void {
    if (!this.enabled) return
    if (this.#records.length >= this.#max) this.#records.shift()
    this.#records.push(rec)

    if (this.verbose) {
      const tag = rec.outcome === "ok" ? "" : ` ${rec.outcome.toUpperCase()}`
      // eslint-disable-next-line no-console
      console.debug(
        `[sdn-timing] ${rec.phase}${tag}` +
          (rec.sid ? ` sid=${rec.sid}` : "") +
          (rec.worker !== undefined ? ` w${rec.worker}` : "") +
          ` ${round(rec.ms)}ms` +
          (rec.bytes !== undefined ? ` ${round(rec.bytes / 1024)}KB` : "") +
          (rec.error ? ` err=${rec.error}` : "")
      )
    }
  }

  /** Per-phase aggregate stats, including ok/failed/cancelled counts. */
  summary(): Record<string, PhaseStats> {
    const byPhase = new Map<string, TimingRecord[]>()
    for (const r of this.#records) {
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

  /** `console.table` of {@link summary}. */
  table(): void {
    // eslint-disable-next-line no-console
    console.table(this.summary())
  }

  /** Flat CSV for spreadsheet analysis (one row per record). */
  csv(): string {
    const head = "ts,phase,outcome,sid,worker,ms,bytes,error,extra"
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
    const rows = this.#records.map(r =>
      [
        round(r.ts),
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
