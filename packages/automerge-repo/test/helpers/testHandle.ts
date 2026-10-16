import { next as A } from "@automerge/automerge/slim"
import { DocHandle } from "../../src/DocHandle.js"
import { Document } from "../../src/Document.js"
import { RootQuery } from "../../src/DocumentQuery.js"
import type { DocumentId } from "../../src/types.js"

const documents = new WeakMap<DocHandle<any>, Document<any>>()

/** Construct a fresh DocHandle suitable for use in tests. */
export function createTestHandle<T>(documentId: DocumentId): DocHandle<T> {
  const document = new Document<T>(documentId, A.init<T>())
  const handle = new DocHandle<T>(document)
  documents.set(handle, document)
  return handle
}

/** Construct a RootQuery wrapping a fresh DocHandle. */
export function createTestQuery<T>(documentId: DocumentId): RootQuery<T> {
  return new RootQuery<T>(createTestHandle<T>(documentId))
}

/** Deliver inbound data to a handle created by {@link createTestHandle}. */
export function applyInbound<T>(
  handle: DocHandle<T>,
  fn: (doc: A.Doc<T>) => A.Doc<T>
): Promise<void> {
  const document = documents.get(handle)
  if (!document) throw new Error("Not a test handle")
  return document.applyMutation(fn, { incoming: true })
}
