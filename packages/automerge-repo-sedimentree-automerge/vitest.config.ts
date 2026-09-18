import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@automerge/automerge-repo-sedimentree/testing": new URL(
        "../automerge-repo-sedimentree/src/testing/index.ts",
        import.meta.url
      ).pathname,
      "@automerge/automerge-repo-sedimentree": new URL(
        "../automerge-repo-sedimentree/src/index.ts",
        import.meta.url
      ).pathname,
    },
  },
  test: { name: "sedimentree-automerge", environment: "node" },
})
