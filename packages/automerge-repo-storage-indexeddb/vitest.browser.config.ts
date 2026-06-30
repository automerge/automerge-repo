/**
 * Gated real-browser bench config (Playwright provider) for the IndexedDB
 * adapters. Runs `test/**\/*.browser.test.ts` against real IndexedDB + real
 * Workers — neither exists under the default happy-dom suite, so these are
 * excluded from `pnpm test` (see the root `vitest.config.ts`).
 *
 * Run:
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/nix/store/<hash>-playwright-browsers \
 *   BENCH_BROWSERS=chromium,firefox,webkit \
 *     pnpm --filter @automerge/automerge-repo-storage-indexeddb exec \
 *     vitest run --config vitest.browser.config.ts
 *
 * On NixOS, point `PLAYWRIGHT_BROWSERS_PATH` at a `playwright-browsers` nix
 * derivation whose browser revisions match the installed Playwright version;
 * the npm-downloaded browsers don't run under the FHS-less environment.
 *
 * Knobs (all optional): BENCH_BROWSERS, BENCH_RECORDS, BENCH_BLOB,
 * BENCH_REPEATS, BENCH_CONTENTION_MS.
 */
import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

const browsers = (process.env.BENCH_BROWSERS ?? "chromium")
  .split(",")
  .map(b => b.trim())
  .filter(Boolean)

export default defineConfig({
  // Bench knobs travel shell -> browser as compile-time constants (the bench
  // runs in-browser, where `process.env` is unavailable).
  define: {
    __BENCH_RECORDS__: JSON.stringify(process.env.BENCH_RECORDS ?? "2000"),
    __BENCH_BLOB__: JSON.stringify(process.env.BENCH_BLOB ?? "4096"),
    __BENCH_REPEATS__: JSON.stringify(process.env.BENCH_REPEATS ?? "3"),
    __BENCH_CONTENTION_MS__: JSON.stringify(
      process.env.BENCH_CONTENTION_MS ?? "8"
    ),
  },
  test: {
    include: ["test/**/*.browser.test.ts"],
    // Benches drive large IndexedDB workloads; give them room.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      // Each instance is a separate real browser engine.
      instances: browsers.map(browser => ({ browser })),
    },
  },
})
