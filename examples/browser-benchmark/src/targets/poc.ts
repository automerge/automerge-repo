// Fullfat entrypoints initialize WASM before the slim-backed Repo and backend.
// eslint-disable-next-line no-restricted-imports
import "@automerge/automerge"
import "@automerge/subduction"
// eslint-disable-next-line no-restricted-imports
import { Repo } from "@automerge/automerge-repo"
import {
  SubductionBackend,
  type SubductionStorageAdapterInterface,
} from "@automerge/automerge-repo-subduction"
import { IndexedDBSubductionStorageAdapter } from "@automerge/automerge-repo-subduction-storage-indexeddb"
import type { Handle, StorageStats, Target } from "../target.js"

function profile(
  store: IndexedDBSubductionStorageAdapter,
  stats: StorageStats
): SubductionStorageAdapterInterface {
  return {
    async loadMany(keys) {
      const start = performance.now()
      try {
        const values = await store.loadMany(keys)
        stats.load.values += values.filter(value => value !== undefined).length
        return values
      } finally {
        stats.load.calls++
        stats.load.elapsedMs += performance.now() - start
      }
    },
    // Each batch is one IndexedDB transaction, counted as one save.
    async saveBatch(entries) {
      const start = performance.now()
      try {
        return await store.saveBatch(entries)
      } finally {
        stats.save.calls++
        stats.save.elapsedMs += performance.now() - start
      }
    },
    async list(prefix) {
      const start = performance.now()
      try {
        const keys = await store.list(prefix)
        stats.list.values += keys.length
        return keys
      } finally {
        stats.list.calls++
        stats.list.elapsedMs += performance.now() - start
      }
    },
    // Each batch is one IndexedDB transaction, counted as one remove.
    async removeBatch(keys) {
      const start = performance.now()
      try {
        return await store.removeBatch(keys)
      } finally {
        stats.remove.calls++
        stats.remove.elapsedMs += performance.now() - start
      }
    },
    async removeRange(prefix) {
      const start = performance.now()
      try {
        return await store.removeRange(prefix)
      } finally {
        stats.remove.calls++
        stats.remove.elapsedMs += performance.now() - start
      }
    },
    async loadPrefix(prefix) {
      const start = performance.now()
      try {
        const entries = await store.loadPrefix(prefix)
        stats.loadPrefix.values += entries.length
        return entries
      } finally {
        stats.loadPrefix.calls++
        stats.loadPrefix.elapsedMs += performance.now() - start
      }
    },
  }
}

export const target: Target = {
  id: "poc",
  adapter: "backend-poc",
  open(database, stats) {
    const storage = new IndexedDBSubductionStorageAdapter({ database })
    const backend = new SubductionBackend({
      storage: stats ? profile(storage, stats) : storage,
    })
    const repo = new Repo({ backend })
    return {
      import: bytes => repo.import(bytes),
      create: async <T>(initial: T) =>
        (await repo.create(initial)) as unknown as Handle<T>,
      find: async <T>(url: string) =>
        (await repo.find<T>(
          url as Parameters<Repo["find"]>[0]
        )) as unknown as Handle<T>,
      flush: () => repo.flush(),
      async close() {
        try {
          await repo.shutdown()
        } finally {
          try {
            await backend.close()
          } finally {
            await storage.close()
          }
        }
      },
    }
  },
}
