import { MemoryByteStore } from "../src/index.js"

/** Test byte store with atomic batches. Persists across backends that share
 * the instance. `beforeSave` sees every key before anything is committed, so
 * a throw aborts the whole batch; `afterSave` runs once it is committed, so a
 * throw reports an ambiguous failure for a durable write. */
export class TestStore extends MemoryByteStore {
  beforeSave?: (key: string) => Promise<void> | void
  afterSave?: (keys: string[]) => Promise<void> | void

  override async save(key: string, value: Uint8Array): Promise<void> {
    return this.saveBatch([[key, value]])
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
