import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import wasm from "vite-plugin-wasm"

export default defineConfig({
  plugins: [wasm(), react()],
  optimizeDeps: {
    // Wasm packages and anything that re-exports them must be excluded from
    // prebundling.  Otherwise Vite may create two copies of the Wasm glue
    // module, which breaks wasm-bindgen's `instanceof` class identity checks.
    exclude: [
      "@automerge/automerge-subduction",
      "@automerge/automerge-repo",
      "@automerge/automerge-repo-subduction-bridge",
      "@automerge/react",
    ],
  },
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
})
