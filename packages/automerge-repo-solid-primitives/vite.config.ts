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
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    target: "esnext",
    rollupOptions: {
      external: [
        "solid-js",
        "@automerge/automerge",
        "cabbages",
        "solid-js/store",
      ],
    },
  },
  worker: {
    plugins: () => [wasm()],
  },
})
