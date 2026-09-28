import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"

const run = promisify(execFile)
const cwd = fileURLToPath(new URL("../", import.meta.url))

// Test the built package exports in fresh processes, not Vitest's initialized
// runtimes or source aliases. The resolver also catches unwanted imports that
// happen not to initialize WASM in their current implementation.
describe("lightweight package entrypoints", () => {
  it.each([
    ["@automerge/automerge-repo/sedimentree", "sedimentreeId", []],
    ["@automerge/automerge-repo/sedimentree/testing", "MemoryBackend", []],
    [
      "@automerge/automerge-repo/sedimentree/automerge",
      "extractRecords",
      ["@automerge/automerge/slim"],
    ],
    [
      "@automerge/automerge-repo-subduction",
      "SubductionBackend",
      ["@automerge/subduction/slim"],
    ],
  ] as const)(
    "imports %s without orchestration or WASM initialization",
    async (specifier, exported, allowed) => {
      const loader = String.raw`
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === '@automerge/automerge-repo' ||
            specifier === '@automerge/automerge-repo/slim' ||
            (/^@automerge\/(automerge|subduction)(\/|$)/.test(specifier) &&
             !${JSON.stringify(allowed)}.includes(specifier))) {
          throw new Error('Unexpected runtime import: ' + specifier)
        }
        const result = await nextResolve(specifier, context)
        if (/\/automerge-repo\/dist\/(?!sedimentree\/)/.test(new URL(result.url).pathname)) {
          throw new Error('Unexpected Repo orchestration import: ' + result.url)
        }
        return result
      }
    `
      const loaderUrl = `data:text/javascript,${encodeURIComponent(loader)}`
      const script = `
      import { strict as assert } from 'node:assert'
      import { register } from 'node:module'
      register(${JSON.stringify(loaderUrl)}, import.meta.url)
      const forbidden = new Set(['Module', 'Instance', 'instantiate', 'instantiateStreaming', 'compile', 'compileStreaming'])
      globalThis.WebAssembly = new Proxy(globalThis.WebAssembly, {
        get(target, name) {
          if (forbidden.has(name)) return function () { throw new Error('Unexpected WASM initialization: ' + name) }
          return Reflect.get(target, name)
        }
      })
      const api = await import(${JSON.stringify(specifier)})
      assert.equal(typeof api[${JSON.stringify(exported)}], 'function')
    `
      await run(process.execPath, ["--input-type=module", "--eval", script], {
        cwd,
      })
    }
  )
})
