import { next as A } from "@automerge/automerge/slim"
import { DocHandle } from "../../src/DocHandle.js"
import { Document } from "../../src/Document.js"
import { RootQuery } from "../../src/DocumentQuery.js"
import type { DocumentId } from "../../src/types.js"

const documents = new WeakMap<DocHandle<any>, Document<any>>()

/**
 * Wire a Document, root handle and query as Repo does. Ready unless
 * `ready: false`, for tests driving the query themselves.
 */
export function createTestDocument<T>(
  documentId: DocumentId,
  doc: A.Doc<T> = A.init<T>(),
  { ready = true }: { ready?: boolean } = {}
): { document: Document<T>; handle: DocHandle<T>; query: RootQuery<T> } {
  const document = new Document<T>(documentId, doc)
  const handle = new DocHandle<T>(document)
  const query = new RootQuery<T>(handle)
  document.query = query
  if (ready) query.ready()
  documents.set(handle, document)
  return { document, handle, query }
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
  const document = documents.get(handle)
  if (!document) throw new Error("Not a test handle")
  return document.applyMutation(fn, { incoming: true })
}
