import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import wasm from "vite-plugin-wasm"
import { fileURLToPath } from "node:url"

export default defineConfig({
  plugins: [wasm(), react()],
  resolve: {
    alias: [
      {
        find: /^@automerge\/subduction$/,
        replacement: fileURLToPath(
          new URL("./web.js", import.meta.resolve("@automerge/subduction"))
        ),
      },
    ],
  },
  build: { target: "esnext" },
  optimizeDeps: {
    exclude: [
      "@automerge/automerge",
      "@automerge/automerge-repo",
      "@automerge/automerge-repo-subduction",
      "@automerge/react",
      "@automerge/subduction",
    ],
  },
})
