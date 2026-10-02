import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"

const run = promisify(execFile)
const cwd = fileURLToPath(new URL("../", import.meta.url))

describe("@automerge/react built entrypoints", () => {
  it("re-exports the current APIs and initializes both runtimes", async () => {
    await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { strict as assert } from 'node:assert'
      import * as api from '@automerge/react'
      for (const name of ['Repo', 'DocHandle', 'RepoContext', 'useRepo',
        'useDocument', 'useDocuments', 'useDocHandle', 'useDocHandles',
        'useLocalAwareness', 'useRemoteAwareness', 'usePresence',
        'SubductionBackend', 'createSubductionPeer', 'connectSubductionServer',
        'MemoryByteStore', 'IndexedDBByteStore']) {
        assert.notEqual(api[name], undefined, name)
      }
      for (const name of ['createRepo', 'RepoHandle', 'RepoQuery',
        'BroadcastChannelNetworkAdapter', 'MessageChannelNetworkAdapter',
        'WebSocketClientAdapter', 'IndexedDBStorageAdapter']) {
        assert.equal(name in api, false, name)
      }
      const slim = await import('@automerge/react/slim')
      for (const name of Object.keys(api)) assert.ok(name in slim, name)
      assert.equal(typeof slim.initializeWasm, 'function')
      const peer = api.createSubductionPeer()
      const repo = new api.Repo({ backend: peer.backend })
      try {
        const handle = await repo.create({ count: 0 })
        assert.ok(handle instanceof api.DocHandle)
        const saved = handle.change(doc => { doc.count = 1 })
        assert.equal(handle.doc().count, 1)
        await saved
        await handle.sub('count').change(2)
        assert.equal((await repo.find(handle.url)), handle)
        assert.equal(handle.doc().count, 2)
        await repo.flush()
      } finally {
        await repo.shutdown()
        await peer.close()
      }
    `,
      ],
      { cwd }
    )
  })

  it("imports slim without initializing either WASM runtime", async () => {
    await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { strict as assert } from 'node:assert'
      import { register } from 'node:module'
      const loader =
        'export async function resolve(name, context, nextResolve) {' +
        'if (name === "@automerge/automerge" || name === "@automerge/automerge-repo" || name === "@automerge/subduction")' +
        'throw new Error("Unexpected fullfat import: " + name);' +
        'return nextResolve(name, context); }'
      register('data:text/javascript,' + encodeURIComponent(loader), import.meta.url)
      const forbidden = new Set(['Module', 'Instance', 'instantiate', 'instantiateStreaming', 'compile', 'compileStreaming'])
      globalThis.WebAssembly = new Proxy(globalThis.WebAssembly, {
        get(target, name) {
          if (forbidden.has(name)) return () => { throw new Error('Unexpected WASM initialization') }
          return Reflect.get(target, name)
        }
      })
      const api = await import('@automerge/react/slim')
      assert.equal(typeof api.Repo, 'function')
      assert.equal(typeof api.createSubductionPeer, 'function')
      assert.equal(typeof api.useDocument, 'function')
      new api.IndexedDBByteStore()
    `,
      ],
      { cwd }
    )
  })
})
