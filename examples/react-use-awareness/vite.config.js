import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import wasm from "vite-plugin-wasm"

export default defineConfig({
  plugins: [react(), wasm()],
  worker: {
    plugins: () => [wasm()],
  },
})
