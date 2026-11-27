import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "repo-subduction-storage-indexeddb",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
