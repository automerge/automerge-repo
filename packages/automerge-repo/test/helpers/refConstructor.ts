import { RefImpl } from "../../src/refs/ref.js"
import { DocHandle } from "../../src/DocHandle.js"
import { DocumentQuery } from "../../src/DocumentQuery.js"
import type { DocumentId } from "../../src/types.js"
import type { PathInput } from "../../src/refs/types.js"

/**
 * The refConstructor that DocHandle requires. Production code passes this
 * from Repo; tests need their own.
 */
export const testRefConstructor = <TDoc, TPath extends readonly PathInput[]>(
  handle: DocHandle<TDoc>,
  path: [...TPath]
) => new RefImpl(handle, path)

/**
 * Construct a fresh DocHandle suitable for use in tests.
 */
export function createTestHandle<T>(documentId: DocumentId): DocHandle<T> {
  return new DocHandle<T>(documentId, testRefConstructor)
}

/**
 * Construct a DocumentQuery wrapping a fresh DocHandle.
 */
export function createTestQuery<T>(documentId: DocumentId): DocumentQuery<T> {
  return new DocumentQuery<T>(createTestHandle<T>(documentId))
}
