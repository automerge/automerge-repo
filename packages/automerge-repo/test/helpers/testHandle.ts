import { next as A } from "@automerge/automerge/slim"
import type { DocHandle } from "../../src/DocHandle.js"
import { DocumentState } from "../../src/DocumentState.js"
import type { RootQuery } from "../../src/DocumentQuery.js"
import type { DocumentId } from "../../src/types.js"

const states = new WeakMap<DocHandle<any>, DocumentState<any>>()

/** Stands in for the owning Document: edits are accepted and stored nowhere. */
export const noopOwner = {
  commit: async () => {},
}

/**
 * A DocumentState with its root handle and query, without a backend. Ready unless
 * `ready: false`, for tests driving the query themselves.
 */
export function createTestDocument<T>(
  documentId: DocumentId,
  doc: A.Doc<T> = A.init<T>(),
  { ready = true }: { ready?: boolean } = {}
): { state: DocumentState<T>; handle: DocHandle<T>; query: RootQuery<T> } {
  const state = new DocumentState<T>(documentId, noopOwner, doc)
  const { handle, query } = state
  if (ready) query.ready()
  states.set(handle, state)
  return { state, handle, query }
}

/** Construct a fresh, ready DocHandle suitable for use in tests. */
export function createTestHandle<T>(documentId: DocumentId): DocHandle<T> {
  return createTestDocument<T>(documentId).handle
}

/** Construct a loading RootQuery and its root handle. */
export function createTestQuery<T>(documentId: DocumentId): {
  query: RootQuery<T>
  handle: DocHandle<T>
} {
  const { query, handle } = createTestDocument<T>(documentId, undefined, {
    ready: false,
  })
  return { query, handle }
}

/** Deliver inbound data to a handle created by {@link createTestDocument}. */
export function applyInbound<T>(
  handle: DocHandle<T>,
  fn: (doc: A.Doc<T>) => A.Doc<T>
): Promise<void> {
  const state = states.get(handle)
  if (!state) throw new Error("Not a test handle")
  return state.applyMutation(fn, { incoming: true })
}
