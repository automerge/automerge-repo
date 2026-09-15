import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"
import { resolve } from "path"
import dts from "vite-plugin-dts"
import wasm from "vite-plugin-wasm"
import { visualizer } from "rollup-plugin-visualizer"

export default defineConfig({
  plugins: [
    solid(),
    wasm(),
    dts({
      insertTypesEntry: true,
      tsconfigPath: "./tsconfig.build.json",
    }),
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
      // path before the check.
      external: (id: string) =>
        !id.startsWith("\0") &&
        !id.startsWith(".") &&
        !id.startsWith(resolve(__dirname, "src")),
    },
  },
  resolve: {
    conditions: ["solid", "browser", "module", "import"],
    mainFields: ["browser", "module", "main"],
  },
  worker: {
    plugins: () => [wasm()],
  },
})
