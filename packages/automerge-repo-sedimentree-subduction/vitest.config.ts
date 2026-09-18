import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@automerge/automerge-repo-sedimentree": new URL(
        "../automerge-repo-sedimentree/src/index.ts",
        import.meta.url
      ).pathname,
    },
  },
  test: {
    name: "sedimentree-subduction",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
