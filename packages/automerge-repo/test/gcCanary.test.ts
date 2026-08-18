import { describe, expect, it } from "vitest"
import { gcAvailable } from "./helpers/flushGC.js"

describe("GC test infrastructure", () => {
  // Guards the execArgv wiring in vitest.config.ts: every GC-dependent suite
  // skips quietly when --expose-gc doesn't reach the workers, so a wiring
  // regression would silently disable them all. Fail loudly in CI instead.
  it.runIf(process.env.CI)("--expose-gc reaches test workers", () => {
    expect(gcAvailable).toBe(true)
  })
})
