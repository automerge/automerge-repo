import { defineProject } from "vitest/config"

export default defineProject({
  test: {
    name: "@automerge/react",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
