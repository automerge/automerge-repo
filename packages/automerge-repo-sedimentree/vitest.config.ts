import { defineConfig } from "vitest/config"

// Deliberately do not inherit the root's Automerge/WASM test setup.
export default defineConfig({
  test: { name: "sedimentree", environment: "node" },
})
