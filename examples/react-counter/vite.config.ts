import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import wasm from "vite-plugin-wasm"

export default defineConfig({
  plugins: [wasm(), react()],
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
})
