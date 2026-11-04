import type { RecordBatch } from "../../src/sedimentree/index.js"

export const hasCommits = (batch: RecordBatch) =>
  batch.some(record => record.kind === "commit")

/**
 * Store calls that carry commits. A commit whose random hash is a fragment
 * boundary (~1 in 256) also gets a fragment-only store from flush or the
 * compaction timer; exact store counts must ignore those.
 */
export function commitStores<Id>(store: {
  mock: { calls: [Id, RecordBatch][] }
}): [Id, RecordBatch][] {
  return store.mock.calls.filter(([, batch]) => hasCommits(batch))
}
