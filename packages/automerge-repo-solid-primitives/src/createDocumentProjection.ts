import { createMemo, type Accessor } from "solid-js"
import { type DocHandle, type Doc } from "@automerge/automerge-repo/slim"
import makeDocumentProjection from "./makeDocumentProjection.js"

/**
 * get a fine-grained live view of a document from a handle. works with
 * {@link useDocHandle}.
 * @param handle an accessor (signal/resource) of a
 * [DocHandle](https://automerge.org/automerge-repo/classes/_automerge_automerge_repo.DocHandle.html)
 */
export default function createDocumentProjection<T extends object>(
  handle: Accessor<DocHandle<T> | undefined>
): Accessor<Doc<T> | undefined> {
  const projection = createMemo<Doc<T> | undefined>(() => {
    const unwrappedHandle = typeof handle == "function" ? handle() : handle
    return unwrappedHandle && makeDocumentProjection<T>(unwrappedHandle)
  })
  return projection
}
