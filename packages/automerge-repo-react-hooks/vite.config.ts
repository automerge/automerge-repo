import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import { resolve } from "path"
import dts from "vite-plugin-dts"
import wasm from "vite-plugin-wasm"
import { visualizer } from "rollup-plugin-visualizer"

export default defineConfig({
  plugins: [
    react({ jsxRuntime: "automatic" }),
    wasm(),
    dts({ insertTypesEntry: true }),
    process.env.VISUALIZE && visualizer(),
  ],
  build: {
    minify: false,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    target: "esnext",
    rollupOptions: {
      // Bundle this package's own source and nothing else. Matching on
      // specifiers alone missed workspace siblings, which vite resolves to a
      // path before the check, so parts of automerge-repo were inlined.
      external: (id: string) =>
        !id.startsWith("\0") &&
        !id.startsWith(".") &&
        !id.startsWith(resolve(__dirname, "src")),
      output: {
        globals: {
          react: "React",
          "react/jsx-runtime": "react/jsx-runtime",
          "react-dom": "ReactDOM",
        },
      },
    },
  },
  worker: {
    plugins: () => [wasm()],
  },
})
