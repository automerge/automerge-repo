import { defineConfig } from "vitest/config"
import path from "path"

// The settings every package inherits. Exported separately from the default
// config because a project config that declares `projects` is treated as a
// nested project container, and the glob would resolve relative to the package.
export const sharedConfig = defineConfig({
  test: {
    globals: true,
    setupFiles: [path.join(__dirname, "./testSetup.ts")],

    // This should _not_ be jsdom, because the jsdom polyfill breaks various
    // instanceof tests when going back and forth from wasm-bindgen
    environment: "happy-dom",

    // Expose globalThis.gc to test workers so GC-dependent tests can opt in.
    // Vitest 4 reads `test.execArgv` per project (cli-api: project.config.execArgv);
    // poolOptions on its own doesn't reach project workers under `projects`.
    execArgv: ["--expose-gc"],

    coverage: {
      provider: "v8",
      reporter: ["lcov", "text", "html"],
      skipFull: true,
      exclude: [
        "**/fuzz",
        // Test doubles and shared test utilities that live under src.
        "**/src/helpers/Dummy*",
        "**/src/helpers/tests/**",
        "**/coverage",
        "examples/**/*",
        "docs/**/*",
        "**/test/**/*",
      ],
    },
  },
})

export default defineConfig({
  test: {
    ...sharedConfig.test,
    projects: ["packages/*"],
  },
})
