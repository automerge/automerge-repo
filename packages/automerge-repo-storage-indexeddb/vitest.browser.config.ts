/**
 * Gated real-browser bench (Playwright) for the IndexedDB adapters; excluded
 * from `pnpm test`. On NixOS, `PLAYWRIGHT_BROWSERS_PATH` must point at a
 * `playwright-browsers` derivation matching the installed Playwright:
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/nix/store/<hash>-playwright-browsers \
 *     pnpm --filter @automerge/automerge-repo-storage-indexeddb bench
 *
 * Knobs: BENCH_BROWSERS, BENCH_RECORDS, BENCH_BLOB, BENCH_BATCH, BENCH_REPEATS,
 * BENCH_CONTENTION_MS.
 */
import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

const browsers = (process.env.BENCH_BROWSERS ?? "chromium")
  .split(",")
  .map(b => b.trim())
  .filter(Boolean)

export default defineConfig({
  // process.env is unavailable in-browser; inject knobs as constants.
  define: {
    __BENCH_RECORDS__: JSON.stringify(process.env.BENCH_RECORDS ?? "2000"),
    __BENCH_BLOB__: JSON.stringify(process.env.BENCH_BLOB ?? "4096"),
    // records per saveBatch (small = chattier RPC)
    __BENCH_BATCH__: JSON.stringify(process.env.BENCH_BATCH ?? "100"),
    __BENCH_REPEATS__: JSON.stringify(process.env.BENCH_REPEATS ?? "3"),
    __BENCH_CONTENTION_MS__: JSON.stringify(
      process.env.BENCH_CONTENTION_MS ?? "8"
    ),
  },
  test: {
    include: ["test/**/*.browser.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: browsers.map(browser => ({ browser })),
    },
  },
})
