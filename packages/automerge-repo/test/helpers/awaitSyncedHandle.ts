import type { DocHandle } from "../../src/DocHandle.js"
import type { DocumentProgress } from "../../src/DocumentQuery.js"
import { awaitDoc } from "./awaitDoc.js"
import { awaitProgress } from "./awaitProgress.js"

/**
 * Open a document that is still arriving from a peer and resolve once it is
 * ready and its content satisfies `predicate`, returning the ready handle.
 *
 * Two steps, because they observe different signals: `progress.subscribe()`
 * fires on query-state transitions (so it sees loading→ready and tolerates a
 * transient "unavailable"), but not on doc-content changes once "ready" — so
 * the content must be awaited on the handle's heads-changed event instead.
 * Using `find()` here would instead reject on the transient "unavailable".
 */
export async function awaitSyncedHandle<T>(
  progress: DocumentProgress<T>,
  predicate: (handle: DocHandle<T>) => boolean = () => true,
  { timeout }: { timeout?: number } = {}
): Promise<DocHandle<T>> {
  await awaitProgress(progress, s => s.state === "ready", { timeout })
  const state = progress.peek()
  if (state.state !== "ready") {
    throw new Error(`expected "ready", got "${state.state}"`)
  }
  await awaitDoc(state.handle, predicate, { timeout })
  return state.handle
}
