import { next as A } from "@automerge/automerge/slim"
import { DocHandle } from "../../src/DocHandle.js"
import { Document } from "../../src/Document.js"
import { DocumentQuery } from "../../src/DocumentQuery.js"
import type { DocumentId } from "../../src/types.js"

/** Construct a fresh DocHandle suitable for use in tests. */
export function createTestHandle<T>(documentId: DocumentId): DocHandle<T> {
  return new DocHandle<T>(new Document<T>(documentId, A.init<T>()))
}

/** Construct a DocumentQuery wrapping a fresh DocHandle. */
export function createTestQuery<T>(documentId: DocumentId): DocumentQuery<T> {
  return new DocumentQuery<T>(createTestHandle<T>(documentId))
}
