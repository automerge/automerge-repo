import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "repo-subduction-network-websocket",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
