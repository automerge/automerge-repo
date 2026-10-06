// Fullfat entrypoints initialize the branch's Automerge runtime.
// eslint-disable-next-line no-restricted-imports
import "@automerge/automerge"
// eslint-disable-next-line no-restricted-imports
import { Repo } from "@automerge/automerge-repo"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import type { Handle, Target } from "../target.js"

export const target: Target = {
  id: "main",
  adapter: "legacy-storage",
  open(database) {
    const storage = new IndexedDBStorageAdapter(database)
    const repo = new Repo({ storage })
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
