import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import topLevelAwait from "vite-plugin-top-level-await"
import wasm from "vite-plugin-wasm"

export default defineConfig({
  plugins: [wasm(), topLevelAwait(), react()],
  optimizeDeps: {
    // Exclude wasm packages from prebundling
    exclude: ["@automerge/automerge-subduction"],
  },
  worker: {
    format: "es",
    plugins: () => [wasm(), topLevelAwait()],
  },
})
