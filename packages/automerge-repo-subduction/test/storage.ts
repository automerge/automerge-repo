import * as N from "@automerge/subduction"
import {
  checkpointId,
  commitId,
  type SedimentreeId,
  type SedimentreeRecord,
} from "@automerge/automerge-repo/sedimentree"
import { DummySubductionStorageAdapter } from "../src/helpers/DummySubductionStorageAdapter.js"
import { StorageBridge, nativeId } from "../src/storage.js"
import type { SubductionStorageAdapterInterface } from "../src/index.js"

/** Test inspection: stored records, commits then fragments, decoded by a
 * scratch node over the same storage. */
export async function storedRecords(
  storage: SubductionStorageAdapterInterface | StorageBridge,
  id: SedimentreeId
): Promise<SedimentreeRecord[]> {
  const bridge =
    storage instanceof StorageBridge ? storage : new StorageBridge(storage)
  const node = new N.Subduction({
    signer: N.createMemorySigner(),
    storage: bridge,
  })
  const native = nativeId(id)
  try {
    const blob = async (digest: string) => {
      const value = await node.getBlob(native, digest)
      if (!value) throw new Error("Missing stored blob")
      return value
    }
    const records: SedimentreeRecord[] = []
    for (const c of (await node.getCommits(native)) ?? [])
      records.push({
        kind: "commit",
        id: commitId(c.head),
        parents: c.parents.map(commitId),
        blob: await blob(c.blobMeta.digest),
      })
    for (const f of (await node.getFragments(native)) ?? [])
      records.push({
        kind: "fragment",
        head: commitId(f.head),
        boundary: f.boundary.map(commitId),
        checkpoints: f.checkpoints.map(checkpointId),
        blob: await blob(f.blobMeta.digest),
      })
    return records
  } finally {
    try {
      await node.close()
    } finally {
      node.free()
    }
  }
}

/** Test storage adapter with atomic batches. Persists across backends that
 * share the instance. `beforeSave` sees every key before anything is
 * committed, so a throw aborts the whole batch; `afterSave` runs once it is
 * committed, so a throw reports an ambiguous failure for a durable write.
 * `load`/`save`/`remove` are single-key conveniences for tests. */
export class TestStore extends DummySubductionStorageAdapter {
  beforeSave?: (key: string) => Promise<void> | void
  afterSave?: (keys: string[]) => Promise<void> | void

  async load(key: string): Promise<Uint8Array | undefined> {
    return (await this.loadMany([key]))[0]
  }

  async save(key: string, value: Uint8Array): Promise<void> {
    return this.saveBatch([[key, value]])
  }

  async remove(key: string): Promise<void> {
    return this.removeBatch([key])
  }

  override async saveBatch(
    entries: readonly [string, Uint8Array][]
  ): Promise<void> {
    const copies = entries.map(
      ([key, value]) => [key, value.slice()] as [string, Uint8Array]
    )
    for (const [key] of copies) await this.beforeSave?.(key)
    await super.saveBatch(copies)
    await this.afterSave?.(copies.map(([key]) => key))
  }
}

/** Keys written through a `vi.spyOn(store, "saveBatch")` spy. */
export function savedKeys(spy: {
  mock: { calls: [entries: readonly [string, Uint8Array][]][] }
}): string[] {
  return spy.mock.calls.flatMap(([entries]) => entries.map(([key]) => key))
}

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}
