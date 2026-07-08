/**
 * Real-browser (Playwright) tests for browser-only components — currently
 * the worker-based WebSocket transport, which needs a real `Worker` and a
 * real `WebSocket`. Excluded from `pnpm test` (the root config skips
 * `*.browser.test.ts`); run with:
 *
 *   pnpm --filter @automerge/automerge-repo test:browser
 *
 * On NixOS, either point `PLAYWRIGHT_BROWSERS_PATH` at a
 * `playwright-browsers` derivation matching the installed Playwright
 * version, or set `PLAYWRIGHT_CHROMIUM_BIN` to a system Chromium
 * (e.g. `PLAYWRIGHT_CHROMIUM_BIN=$(command -v chromium)`).
 */
import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"
import { wsEchoServerCommands } from "./test/helpers/wsEchoServerCommands.js"

const isBrowserName = (b: string): b is "chromium" | "firefox" | "webkit" =>
  b === "chromium" || b === "firefox" || b === "webkit"

const browsers = (process.env.TEST_BROWSERS ?? "chromium")
  .split(",")
  .map(b => b.trim())
  .filter(isBrowserName)

export default defineConfig({
  // process.env is unavailable in-browser; inject bench knobs as constants.
  // The bench suite is skipped unless WS_BENCH=1.
  define: {
    __WS_BENCH__: JSON.stringify(process.env.WS_BENCH ?? ""),
    __WS_BENCH_MSGS__: JSON.stringify(process.env.WS_BENCH_MSGS ?? "500"),
    __WS_BENCH_BLOB__: JSON.stringify(process.env.WS_BENCH_BLOB ?? "16384"),
    __WS_BENCH_REPEATS__: JSON.stringify(process.env.WS_BENCH_REPEATS ?? "3"),
    __WS_BENCH_CONTENTION_MS__: JSON.stringify(
      process.env.WS_BENCH_CONTENTION_MS ?? "8"
    ),
  },
  test: {
    include: ["test/**/*.browser.test.ts"],
    testTimeout: process.env.WS_BENCH ? 600_000 : 30_000,
    hookTimeout: process.env.WS_BENCH ? 600_000 : 30_000,
    browser: {
      enabled: true,
      provider: playwright(
        process.env.PLAYWRIGHT_CHROMIUM_BIN
          ? {
              launchOptions: {
                executablePath: process.env.PLAYWRIGHT_CHROMIUM_BIN,
              },
            }
          : {}
      ),
      headless: true,
      instances: browsers.map(browser => ({ browser })),
      commands: wsEchoServerCommands,
    },
  },
})
