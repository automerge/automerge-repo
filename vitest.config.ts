import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./testSetup.ts"],
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
