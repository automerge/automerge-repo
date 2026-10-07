// Fullfat entrypoints initialize WASM before the slim-backed Repo and peer.
// eslint-disable-next-line no-restricted-imports
import "@automerge/automerge"
import "@automerge/subduction"
// eslint-disable-next-line no-restricted-imports
import { Repo } from "@automerge/automerge-repo"
import {
  createSubductionPeer,
  IndexedDBByteStore,
  type LocalByteStore,
} from "@automerge/automerge-repo-subduction"
import type { Handle, StorageStats, Target } from "../target.js"

function profile(
  store: IndexedDBByteStore,
  stats: StorageStats
): LocalByteStore {
  return {
    async load(key) {
      const start = performance.now()
      try {
        return await store.load(key)
      } finally {
        stats.load.calls++
        stats.load.elapsedMs += performance.now() - start
      }
    },
    async save(key, bytes) {
      const start = performance.now()
      try {
        return await store.save(key, bytes)
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
    async remove(key) {
      const start = performance.now()
      try {
        return await store.remove(key)
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
    const storage = new IndexedDBByteStore({ database })
    const peer = createSubductionPeer({
      storage: stats ? profile(storage, stats) : storage,
    })
    const repo = new Repo({ backend: peer.backend })
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
            await peer.close()
          } finally {
            await storage.close()
          }
        }
      },
    }
  },
}
