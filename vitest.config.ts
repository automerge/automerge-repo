import { defineConfig } from "vitest/config"
import path from "path"
import solid from "vite-plugin-solid"

export default defineConfig({
  test: {
    projects: ["packages/*"],
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
        "**/helpers",
        "**/coverage",
        "examples/**/*",
        "docs/**/*",
        "**/test/**/*",
      ],
    },
  },
})
