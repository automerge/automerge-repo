// Opens one benchmark target's Repo. Each target runs in its own Node process.
// Fullfat initializes Automerge's WASM for this process.
// eslint-disable-next-line no-restricted-imports
import * as current from "@automerge/automerge"
import { realpathSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { join } from "node:path"

async function fromFile(path) {
  return import(pathToFileURL(path).href)
}

/**
 * Returns `open(store)` for the target, plus the branch's own Automerge (for
 * `splice`/`ImmutableString` inside `change`) and the built code paths the
 * target depends on.
 */
export async function loadTarget(target, directory) {
  if (target === "poc") {
    const root = fileURLToPath(new URL("../../", import.meta.url))
    const codePaths = [
      join(root, "packages/automerge-repo/dist"),
      join(root, "packages/automerge-repo-subduction/dist"),
      realpathSync(
        join(root, "packages/automerge-repo/node_modules/@automerge/automerge")
      ),
      realpathSync(
        join(
          root,
          "packages/automerge-repo-subduction/node_modules/@automerge/subduction"
        )
      ),
    ]
    const { Repo } = await import("@automerge/automerge-repo")
    await import("@automerge/subduction")
    const { SubductionBackend } =
      await import("@automerge/automerge-repo-subduction")
    const open = store => {
      const backend = new SubductionBackend({ storage: store.bytes() })
      const repo = new Repo({ backend })
      return {
        import: bytes => repo.import(bytes),
        create: initial => repo.create(initial),
        clone: handle => repo.clone(handle),
        find: url => repo.find(url),
        flush: () => repo.flush(),
        close: async () => {
          try {
            await repo.shutdown()
          } finally {
            await backend.close()
          }
        },
      }
    }
    return { open, automerge: current, codePaths }
  }
  const base = join(directory, "packages/automerge-repo")
  const { Repo } = await fromFile(join(base, "dist/entrypoints/fullfat.js"))
  const automergePath = realpathSync(
    join(base, "node_modules/@automerge/automerge")
  )
  const automerge = await fromFile(
    join(automergePath, "dist/mjs/entrypoints/slim.js")
  )
  const codePaths = [join(base, "dist"), automergePath]
  if (target === "subductionjs") {
    const native = join(
      base,
      "node_modules/@automerge/automerge-subduction/dist/esm"
    )
    codePaths.push(realpathSync(native))
    const { initSync } = await fromFile(join(native, "slim.js"))
    const { wasmBase64 } = await fromFile(join(native, "wasm-base64.js"))
    initSync({ module: Uint8Array.from(Buffer.from(wasmBase64, "base64")) })
  }
  const open = store => {
    const repo = new Repo({
      storage: store.legacy(),
      ...(target === "subductionjs"
        ? { subductionWebsocketEndpoints: [] }
        : {}),
    })
    return {
      import: bytes => repo.import(bytes),
      create: initial => repo.create(initial),
      clone: async handle => repo.clone(handle),
      find: url => repo.find(url),
      flush: () => repo.flush(),
      close: () => repo.shutdown(),
    }
  }
  return { open, automerge, codePaths }
}
