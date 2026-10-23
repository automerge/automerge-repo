import { existsSync, readFileSync, writeFileSync } from "fs"
import { expect } from "vitest"

interface Band {
  tolerance: number
  slack: number
}

/**
 * A two-sided ratchet over a committed JSON file of measured sync costs.
 *
 * Every metric is "lower is better" (bytes, frames, rounds, ratios).
 * `check(name, value)` fails when `value` is worse than the committed
 * baseline by more than the metric's declared tolerance. It *also* fails
 * when `value` is substantially better (by more than the tolerance, and
 * at least 10%): an improvement that is not written into the baseline can
 * erode again without anyone noticing, and a sudden drop is just as often
 * a measurement that stopped seeing traffic as a real gain. Either way,
 * look at it, then record it with `UPDATE_SYNC_BASELINES=1`.
 *
 * Checks are soft (`expect.soft`), so one test reports every metric that
 * moved, not only the first.
 *
 * In update mode the file is rewritten from the current measurements, but
 * a metric still inside its band keeps its committed value, so a noisy
 * metric does not churn the file on every regeneration.
 */
export class SyncBudget {
  readonly updating = !!process.env.UPDATE_SYNC_BASELINES
  #baseline: Record<string, number>
  #measured: Record<string, { value: number; band: Band }> = {}

  constructor(readonly file: string) {
    this.#baseline = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")).metrics ?? {})
      : {}
  }

  /**
   * @param tolerance - allowed relative change (0.05 = 5%) in either
   *   direction before the check fails. Zero for deterministic values.
   * @param slack - allowed absolute change, for small counts where a
   *   relative tolerance is meaningless.
   */
  check(
    name: string,
    value: number,
    { tolerance = 0, slack = 0 }: Partial<Band> = {}
  ): void {
    expect.soft(Number.isFinite(value), `${name} measured ${value}`).toBe(true)
    const band = { tolerance, slack }
    this.#measured[name] = { value, band }
    if (this.updating) return

    const base = this.#baseline[name]
    if (typeof base !== "number") {
      expect
        .soft(
          base,
          `no baseline for "${name}" (measured ${value}); ` +
            `run with UPDATE_SYNC_BASELINES=1 and commit the JSON`
        )
        .toBeTypeOf("number")
      return
    }
    const { worse, better } = limits(base, band)
    expect
      .soft(
        value,
        `${name} regressed: ${round(value)} vs baseline ${round(base)} ` +
          `(tolerance ${tolerance * 100}% + ${slack})`
      )
      .toBeLessThanOrEqual(worse)
    expect
      .soft(
        value,
        `${name} improved: ${round(value)} vs baseline ${round(base)}. ` +
          `If that is a real gain (and not a measurement that stopped ` +
          `seeing traffic), record it: UPDATE_SYNC_BASELINES=1`
      )
      .toBeGreaterThanOrEqual(better)
  }

  /** In update mode, merge this run's values into the baseline file. */
  save(): void {
    if (!this.updating) return
    const metrics: Record<string, number> = { ...this.#baseline }
    for (const [name, { value, band }] of Object.entries(this.#measured)) {
      const base = this.#baseline[name]
      const inBand =
        typeof base === "number" &&
        value <= limits(base, band).worse &&
        value >= limits(base, band).better
      if (!inBand) metrics[name] = round(value)
    }
    // Kept, not dropped: a run filtered with `-t` checks only some metrics.
    const unchecked = Object.keys(this.#baseline).filter(
      k => !(k in this.#measured)
    )
    if (unchecked.length) {
      process.stdout.write(
        `\n[sync-budget] not checked in this run (delete them from ` +
          `${this.file} if they were retired): ${unchecked.join(", ")}\n`
      )
    }
    const sorted = Object.fromEntries(
      Object.keys(metrics)
        .sort()
        .map(k => [k, metrics[k]])
    )
    writeFileSync(
      this.file,
      JSON.stringify(
        {
          note:
            "Measured by SyncThroughput.test.ts. Lower is better. " +
            "Regenerate with UPDATE_SYNC_BASELINES=1 after an intended change.",
          metrics: sorted,
        },
        null,
        2
      ) + "\n"
    )
  }
}

/** Highest value that passes, and lowest value that passes. */
function limits(base: number, { tolerance, slack }: Band) {
  return {
    worse: base * (1 + tolerance) + slack,
    better: base - (base * Math.max(tolerance, 0.1) + slack),
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000
