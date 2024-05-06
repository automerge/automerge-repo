import {
  AnyDocumentId,
  DocHandle,
  DocHandleChangePayload,
} from "@automerge/automerge-repo"
import { ChangeFn, ChangeOptions, Doc } from "@automerge/automerge/next"
import { useEffect, useRef, useState } from "react"
import { useRepo } from "./useRepo.js"

/** A hook which returns a document identified by a URL and a function to change the document.
 *
 * @returns a tuple of the document and a function to change the document.
 * The document will be `undefined` if the document is not available in storage or from any peers
 *
 * @remarks
 * This requires a {@link RepoContext} to be provided by a parent component.
 * */
export function useDocument<T>(
  id?: AnyDocumentId
): [
  Doc<T> | undefined,
  (changeFn: ChangeFn<T>, options?: ChangeOptions<T> | undefined) => void
] {
  const repo = useRepo()

  const handle = id ? repo.find<T>(id) : null
  const handleRef = useRef<DocHandle<T> | null>(null)

  const [docWithId, setDocWithId] = useState<
    { id: AnyDocumentId; doc: Doc<T> | undefined } | undefined
  >(
    (() => {
      const doc = handle?.docSync()
      return id && doc ? { id, doc } : undefined
    })()
  )

  useEffect(() => {
    if (!id || !handle) {
      setDocWithId(undefined)
      return
    }

    // When the handle has changed, reset the doc to the current value of docSync().
    // For already-loaded documents this will be the last known value, for unloaded documents
    // this will be undefined.
    // This ensures that if loading the doc takes a long time, the UI
    // shows a loading state during that time rather than a stale doc.
    setDocWithId({ id, doc: handle?.docSync() })

    handleRef.current = handle
    handle
      .doc()
      .then(v => {
        // Bail out on updating the doc if the handle has changed since we started loading.
        // This avoids problem with out-of-order loads when the handle is changing faster
        // than documents are loading.
        if (handleRef.current !== handle) return
        setDocWithId({ id, doc: v })
      })
      .catch(e => console.error(e))

    const onChange = (h: DocHandleChangePayload<T>) =>
      setDocWithId({ id, doc: h.doc })
    handle.on("change", onChange)
    const onDelete = () => setDocWithId(undefined)
    handle.on("delete", onDelete)
    const cleanup = () => {
      handle.removeListener("change", onChange)
      handle.removeListener("delete", onDelete)
    }

    return cleanup
  }, [id, handle])

  const changeDoc = (
    changeFn: ChangeFn<T>,
    options?: ChangeOptions<T> | undefined
  ) => {
    if (!handle) return
    handle.change(changeFn, options)
  }

  if (!docWithId || docWithId.id !== id) {
    return [undefined, () => {}]
  }

  return [docWithId.doc, changeDoc] as const
}
