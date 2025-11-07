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
