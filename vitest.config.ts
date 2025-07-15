import { defineConfig } from "vitest/config"
import path from "path"
import solid from "vite-plugin-solid"

export default defineConfig({
  test: {
    projects: ["packages/*"],
    globals: true,
    setupFiles: [path.join(__dirname, "./testSetup.ts")],
    environment: "jsdom",
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
