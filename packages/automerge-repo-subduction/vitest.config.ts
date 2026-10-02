import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "repo-subduction",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
