import { defineConfig } from "vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import wasm from "vite-plugin-wasm"

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [wasm(), svelte()],
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
