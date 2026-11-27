import { defineConfig } from "vite"
import wasm from "vite-plugin-wasm"
import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"

const adapter = process.env.BENCH_ADAPTER ?? "poc"
const target = process.env.BENCH_TARGET_DIR
if (!["poc", "legacy", "subductionjs"].includes(adapter))
  throw new Error(`Unknown BENCH_ADAPTER: ${adapter}`)
if (adapter !== "poc" && !target)
  throw new Error("Set BENCH_TARGET_DIR to prepared worktree")

const repo =
  target && join(resolve(target), "packages/automerge-repo/dist/entrypoints")
const storage =
  target &&
  join(resolve(target), "packages/automerge-repo-storage-indexeddb/dist")
const subduction =
  target &&
  join(
    resolve(target),
    "packages/automerge-repo/node_modules/@automerge/automerge-subduction/dist/esm"
  )

export default defineConfig({
  plugins: [wasm()],
  resolve: {
    alias: [
      {
        find: /^bench-target$/,
        replacement: fileURLToPath(
          new URL(`./src/targets/${adapter}.ts`, import.meta.url)
        ),
      },
      ...(repo && storage
        ? [
            {
              find: /^@automerge\/automerge-repo\/slim$/,
              replacement: join(repo, "slim.js"),
            },
            {
              find: /^@automerge\/automerge-repo$/,
              replacement: join(repo, "fullfat.js"),
            },
            {
              find: /^@automerge\/automerge-repo-storage-indexeddb$/,
              replacement: join(storage, "index.js"),
            },
            {
              find: /^@automerge\/automerge\/slim$/,
              replacement: join(
                resolve(target!),
                "node_modules/@automerge/automerge/dist/mjs/entrypoints/slim.js"
              ),
            },
            {
              find: /^@automerge\/automerge$/,
              replacement: join(
                resolve(target!),
                "node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js"
              ),
            },
            ...(adapter === "subductionjs"
              ? [
                  {
                    find: /^@automerge\/automerge-subduction\/slim$/,
                    replacement: join(subduction!, "slim.js"),
                  },
                  {
                    find: /^@automerge\/automerge-subduction\/wasm-base64$/,
                    replacement: join(subduction!, "wasm-base64.js"),
                  },
                ]
              : []),
          ]
        : []),
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
      "@automerge/subduction",
      "@automerge/automerge-subduction",
    ],
  },
})
