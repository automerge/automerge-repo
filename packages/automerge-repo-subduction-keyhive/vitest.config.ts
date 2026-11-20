import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "repo-subduction-keyhive",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
