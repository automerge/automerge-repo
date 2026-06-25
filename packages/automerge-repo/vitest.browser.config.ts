/**
 * Real-browser storage benchmark config (Playwright provider).
 *
 * Runs the `.browser.test.ts` suites under `test/` inside Chromium, Firefox
 * and WebKit so the subduction storage bridge is exercised against real
 * IndexedDB rather than the `fake-indexeddb` shim used by `_repo-perf.test.ts`.
 * These suites are intentionally NOT part of `pnpm test` (the root config
 * excludes the `.browser.test.ts` files); run them explicitly:
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/path/to/playwright-browsers \
 *     pnpm --filter @automerge/automerge-repo exec \
 *     vitest run --config vitest.browser.config.ts
 *
 * On NixOS, point `PLAYWRIGHT_BROWSERS_PATH` at a `playwright-browsers` nix
 * derivation whose browser revisions match the installed Playwright version;
 * the npm-downloaded browsers do not run under the FHS-less environment.
 */
import { resolve } from "node:path"

import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"
import wasm from "vite-plugin-wasm"

// Browsers to bench against. Override with BENCH_BROWSERS=chromium,firefox.
const browsers = (process.env.BENCH_BROWSERS ?? "chromium,firefox,webkit")
  .split(",")
  .map(b => b.trim())
  .filter(Boolean)

// Repo root, so the browser can `fetch` gitignored real-world fixtures under
// `.ignore/bench-fixtures/` via Vite's `/@fs/` route.
const repoRoot = resolve(process.cwd(), "../..")

export default defineConfig({
  plugins: [wasm()],
  // Wasm + top-level await need an esnext target (matches the example apps).
  esbuild: { target: "esnext" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
  // Bench knobs travel shell -> browser via compile-time constants (the bench
  // runs in-browser, where `process.env` is unavailable).
  define: {
    __BENCH_SCALE__: JSON.stringify(process.env.BENCH_SCALE ?? "100,1000"),
    __BENCH_REPEATS__: JSON.stringify(process.env.BENCH_REPEATS ?? "3"),
    // Absolute path of a real-world fixture JSON (from dump-to-fixture.mjs), or
    // "" to skip the replay suite. Fetched in-browser via Vite's `/@fs/` route.
    __BENCH_FIXTURE_PATH__: JSON.stringify(process.env.BENCH_FIXTURE ?? ""),
  },
  // Allow the dev server to serve gitignored fixtures from the repo root.
  server: { fs: { allow: [repoRoot] } },
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
