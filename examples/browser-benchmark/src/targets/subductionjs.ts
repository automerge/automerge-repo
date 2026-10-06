// Fullfat initializes Automerge; Subduction needs its own native initializer.
// eslint-disable-next-line no-restricted-imports
import "@automerge/automerge"
import { initSync } from "@automerge/automerge-subduction/slim"
import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"
// eslint-disable-next-line no-restricted-imports
import { Repo } from "@automerge/automerge-repo"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import type { Handle, Target } from "../target.js"

initSync({ module: Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)) })

export const target: Target = {
  id: "subductionjs",
  adapter: "subductionjs",
  open(database) {
    const storage = new IndexedDBStorageAdapter(database)
    const repo = new Repo({ storage, subductionWebsocketEndpoints: [] })
    return {
      import: async bytes => repo.import(bytes),
      create: async <T>(initial: T) =>
        repo.create(initial) as unknown as Handle<T>,
      find: async <T>(url: string) =>
        (await repo.find<T>(
          url as Parameters<Repo["find"]>[0]
        )) as unknown as Handle<T>,
      flush: () => repo.flush(),
      async close() {
        try {
          await repo.shutdown()
        } finally {
          await storage.close()
        }
      },
    }
  },
}
